import {
  AlignmentType,
  Document,
  Footer,
  FootnoteReferenceRun,
  HeadingLevel,
  ImageRun,
  type IRunOptions,
  LevelFormat,
  Math as OmmlMath,
  type MathComponent,
  MathFraction,
  MathRadical,
  MathRun,
  MathSubScript,
  MathSubSuperScript,
  MathSuperScript,
  Packer,
  PageBreak,
  PageNumber,
  Paragraph,
  type ParagraphChild,
  Table,
  TableCell,
  TableOfContents,
  TableRow,
  TextRun,
  WidthType,
} from 'docx';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';

import { displaySize, rasterType } from './image';
import { type MathNode, parseLatexMath } from './math';
import type { Block, Direction, ExportDocument, Inline, NoteRun } from './model';
import { parseExportDocument } from './model';
import { buildFilename, type ExportResult, WarningCollector } from './result';
import { autoDirection, blockDirection, collectHeadings, label, splitByDirection } from './text';

const TWIPS_PER_MM = 1440 / 25.4;
const PX_PER_MM = 96 / 25.4;
const PAGE_MM = { A4: { width: 210, height: 297 }, Letter: { width: 215.9, height: 279.4 } };
const HEADINGS = [
  HeadingLevel.HEADING_1,
  HeadingLevel.HEADING_2,
  HeadingLevel.HEADING_3,
  HeadingLevel.HEADING_4,
] as const;
const HEADING_SCALE = [1.6, 1.35, 1.15, 1] as const;
const BULLET_REF = 'bahith-bullet';
const NUMBER_REF = 'bahith-numbered';

const twips = (mm: number) => Math.round(mm * TWIPS_PER_MM);

interface RunStyle {
  bold?: boolean | undefined;
  italic?: boolean | undefined;
  /** Size in points; defaults to the template size. */
  sizePt?: number;
}

interface State {
  doc: ExportDocument;
  warnings: WarningCollector;
  footnotes: Record<string, { children: Paragraph[] }>;
  nextFootnote: number;
  nextListInstance: number;
}

function fontOptions(doc: ExportDocument) {
  const family = doc.template.fontFamily;
  // `cs` is the complex-script font Word uses for Arabic runs.
  return { ascii: family, hAnsi: family, cs: family, eastAsia: family };
}

/**
 * Text runs split by script, so `w:rtl` (right-to-left run) is set exactly on the
 * segments that contain Arabic letters; text is passed through unchanged.
 */
function textRuns(
  textValue: string,
  base: Direction,
  state: State,
  style: RunStyle = {},
): TextRun[] {
  const halfPoints = Math.round((style.sizePt ?? state.doc.template.fontSizePt) * 2);
  return splitByDirection(textValue, base).map((segment) => {
    const options: IRunOptions = {
      text: segment.text,
      font: fontOptions(state.doc),
      size: halfPoints,
      sizeComplexScript: halfPoints,
      ...(style.bold === true ? { bold: true, boldComplexScript: true } : {}),
      ...(style.italic === true ? { italics: true, italicsComplexScript: true } : {}),
      ...(segment.rtl ? { rightToLeft: true } : {}),
    };
    return new TextRun(options);
  });
}

function noteParagraph(content: readonly NoteRun[], state: State): Paragraph {
  const dir = autoDirection(content.map((run) => run.text).join(''), state.doc.meta.direction);
  const size = Math.max(state.doc.template.fontSizePt - 3, 8);
  return new Paragraph({
    ...(dir === 'rtl' ? { bidirectional: true } : {}),
    children: content.flatMap((run) =>
      textRuns(
        run.text,
        dir,
        state,
        run.type === 'text'
          ? { bold: run.bold, italic: run.italic, sizePt: size }
          : { sizePt: size },
      ),
    ),
  });
}

function inlineChildren(runs: readonly Inline[], dir: Direction, state: State): ParagraphChild[] {
  return runs.flatMap((run): ParagraphChild[] => {
    switch (run.type) {
      case 'text':
        return textRuns(run.text, dir, state, { bold: run.bold, italic: run.italic });
      case 'citation':
        // Display text from the citation engine, verbatim.
        return textRuns(run.text, dir, state);
      case 'footnote': {
        const id = state.nextFootnote;
        state.nextFootnote += 1;
        state.footnotes[String(id)] = { children: [noteParagraph(run.content, state)] };
        return [new FootnoteReferenceRun(id)];
      }
    }
  });
}

const bidi = (dir: Direction) => (dir === 'rtl' ? { bidirectional: true } : {});

function mathComponents(nodes: readonly MathNode[]): MathComponent[] {
  return nodes.map((node): MathComponent => {
    switch (node.kind) {
      case 'ident':
      case 'number':
      case 'op':
      case 'text':
        return new MathRun(node.text);
      case 'frac':
        return new MathFraction({
          numerator: mathComponents(node.num),
          denominator: mathComponents(node.den),
        });
      case 'sqrt':
        return new MathRadical({
          children: mathComponents(node.body),
          ...(node.index === undefined ? {} : { degree: mathComponents(node.index) }),
        });
      case 'scripts': {
        const children = mathComponents(node.base);
        if (node.sub !== undefined && node.sup !== undefined) {
          return new MathSubSuperScript({
            children,
            subScript: mathComponents(node.sub),
            superScript: mathComponents(node.sup),
          });
        }
        if (node.sub !== undefined)
          return new MathSubScript({ children, subScript: mathComponents(node.sub) });
        return new MathSuperScript({ children, superScript: mathComponents(node.sup ?? []) });
      }
    }
  });
}

function blockChildren(block: Block, state: State): (Paragraph | Table)[] {
  const { doc } = state;
  const dir = blockDirection(block, doc);
  switch (block.type) {
    case 'heading':
      return [
        new Paragraph({
          heading: HEADINGS[block.level - 1] ?? HeadingLevel.HEADING_4,
          // Chapters start on a new page (the cover and TOC already end with a break).
          ...(block.level === 1 && block !== doc.body[0] ? { pageBreakBefore: true } : {}),
          ...bidi(dir),
          children: textRuns(block.text, dir, state, {
            bold: true,
            sizePt: doc.template.fontSizePt * (HEADING_SCALE[block.level - 1] ?? 1),
          }),
        }),
      ];
    case 'paragraph':
      return [
        new Paragraph({
          ...bidi(dir),
          alignment: AlignmentType.BOTH,
          children: inlineChildren(block.runs, dir, state),
        }),
      ];
    case 'blockquote':
      return [
        new Paragraph({
          ...bidi(dir),
          style: 'Quote',
          indent: { start: twips(12), end: twips(12) },
          children: inlineChildren(block.runs, dir, state),
        }),
      ];
    case 'list': {
      const instance = state.nextListInstance;
      state.nextListInstance += 1;
      return block.items.map(
        (item) =>
          new Paragraph({
            ...bidi(dir),
            numbering: { reference: block.ordered ? NUMBER_REF : BULLET_REF, level: 0, instance },
            children: inlineChildren(item, dir, state),
          }),
      );
    }
    case 'table': {
      const cell = (value: string, bold: boolean) =>
        new TableCell({
          children: [
            new Paragraph({ ...bidi(dir), children: textRuns(value, dir, state, { bold }) }),
          ],
        });
      const table = new Table({
        width: { size: 100, type: WidthType.PERCENTAGE },
        ...(dir === 'rtl' ? { visuallyRightToLeft: true } : {}),
        rows: [
          new TableRow({
            tableHeader: true,
            children: block.header.map((value) => cell(value, true)),
          }),
          ...block.rows.map(
            (row) => new TableRow({ children: row.map((value) => cell(value, false)) }),
          ),
        ],
      });
      const caption =
        block.caption === undefined
          ? []
          : [
              new Paragraph({
                ...bidi(dir),
                style: 'Caption',
                children: textRuns(block.caption, dir, state),
              }),
            ];
      return [...caption, table];
    }
    case 'image': {
      const type = rasterType(block.mime);
      const { template } = doc;
      const textWidthMm =
        PAGE_MM[template.pageSize].width - template.margins.start - template.margins.end;
      const size = displaySize(block, textWidthMm * PX_PER_MM);
      const caption =
        block.caption === undefined
          ? []
          : [
              new Paragraph({
                ...bidi(dir),
                style: 'Caption',
                alignment: AlignmentType.CENTER,
                children: textRuns(block.caption, dir, state),
              }),
            ];
      if (type === undefined || size === undefined) {
        // e.g. SVG/WebP (Word needs a raster fallback) or a header we cannot size.
        state.warnings.add('IMAGE_SKIPPED');
        const text = label(doc.meta.language, 'imageOmitted', { alt: block.alt });
        return [
          new Paragraph({
            ...bidi(dir),
            alignment: AlignmentType.CENTER,
            children: textRuns(text, dir, state),
          }),
          ...caption,
        ];
      }
      return [
        new Paragraph({
          alignment: AlignmentType.CENTER,
          children: [
            new ImageRun({
              type,
              data: block.data,
              transformation: size,
              altText: { name: block.alt, description: block.alt, title: block.alt },
            }),
          ],
        }),
        ...caption,
      ];
    }
    case 'equation': {
      const nodes = parseLatexMath(block.latex);
      if (nodes !== undefined) {
        return [
          new Paragraph({
            alignment: AlignmentType.CENTER,
            children: [new OmmlMath({ children: mathComponents(nodes) })],
          }),
        ];
      }
      state.warnings.add('EQUATION_AS_TEXT');
      return [
        new Paragraph({
          alignment: AlignmentType.CENTER,
          children: [
            new TextRun({
              text: block.fallbackText ?? block.latex,
              font: { ascii: 'Cambria Math', hAnsi: 'Cambria Math', cs: 'Cambria Math' },
            }),
          ],
        }),
      ];
    }
  }
}

function coverChildren(state: State): Paragraph[] {
  const { meta, template } = state.doc;
  const dir = meta.direction;
  const line = (value: string | undefined, scale: number, bold = false, spacingAfterPt = 12) =>
    value === undefined || value.trim() === ''
      ? []
      : [
          new Paragraph({
            ...bidi(dir),
            alignment: AlignmentType.CENTER,
            spacing: { after: spacingAfterPt * 20 },
            children: textRuns(value, dir, state, { bold, sizePt: template.fontSizePt * scale }),
          }),
        ];
  return [
    ...line(meta.institution, 1.2, true),
    ...line(meta.department, 1.1),
    new Paragraph({ spacing: { before: 2400 }, children: [] }),
    ...line(meta.title, 2, true, 18),
    ...line(meta.subtitle, 1.4),
    ...line(meta.degree, 1.1, false, 48),
    ...line(`${label(meta.language, 'preparedBy')}: ${meta.author}`, 1.15),
    ...(meta.supervisor === undefined
      ? []
      : line(`${label(meta.language, 'supervisedBy')}: ${meta.supervisor}`, 1.15)),
    ...line(meta.date, 1),
    new Paragraph({ children: [new PageBreak()] }),
  ];
}

function tocChildren(state: State): (Paragraph | TableOfContents)[] {
  const { doc } = state;
  const dir = doc.meta.direction;
  const entries = collectHeadings(doc).map(({ block }) => ({
    title: block.text,
    level: block.level,
  }));
  entries.push({ title: doc.bibliography.heading, level: 1 });
  return [
    new Paragraph({
      ...bidi(dir),
      children: textRuns(label(doc.meta.language, 'tableOfContents'), dir, state, {
        bold: true,
        sizePt: doc.template.fontSizePt * 1.35,
      }),
    }),
    // A real TOC field (Word refreshes it on open, `updateFields`); its cached result is
    // the static heading list, which LibreOffice and viewers that do not update fields show.
    new TableOfContents(label(doc.meta.language, 'tableOfContents'), {
      hyperlink: true,
      headingStyleRange: '1-4',
      cachedEntries: entries,
    }),
    new Paragraph({ children: [new PageBreak()] }),
  ];
}

function bibliographyChildren(state: State): Paragraph[] {
  const { doc } = state;
  const base = doc.meta.direction;
  return [
    new Paragraph({
      heading: HeadingLevel.HEADING_1,
      pageBreakBefore: true,
      ...bidi(base),
      children: textRuns(doc.bibliography.heading, base, state, {
        bold: true,
        sizePt: doc.template.fontSizePt * HEADING_SCALE[0],
      }),
    }),
    // Entries are pre-formatted by the citation engine and copied verbatim.
    ...doc.bibliography.entries.map((entry) => {
      const dir = autoDirection(entry, base);
      return new Paragraph({
        ...bidi(dir),
        indent: { start: twips(12), hanging: twips(12) },
        spacing: { after: 120 },
        children: textRuns(entry, dir, state),
      });
    }),
  ];
}

/**
 * Adds `<w:bidi/>` to every section's properties, which Word uses for the section's
 * reading order (e.g. page-number and column placement). docx has no option for it,
 * so the packed XML is patched; `w:bidi` sits before `w:docGrid` per the schema.
 */
function addSectionBidi(packed: Uint8Array): Uint8Array {
  const files = unzipSync(packed);
  const documentXml = files['word/document.xml'];
  if (documentXml === undefined) return packed;
  const xml = strFromU8(documentXml).replace(
    /<w:sectPr\b[^>]*>[\s\S]*?<\/w:sectPr>/gu,
    (sectPr) => {
      if (sectPr.includes('<w:bidi/>')) return sectPr;
      return sectPr.includes('<w:docGrid')
        ? sectPr.replace('<w:docGrid', '<w:bidi/><w:docGrid')
        : sectPr.replace('</w:sectPr>', '<w:bidi/></w:sectPr>');
    },
  );
  files['word/document.xml'] = strToU8(xml);
  return zipSync(files, { level: 6 });
}

/** Builds the docx `Document` (exposed for tests and callers who post-process). */
export function buildDocx(doc: ExportDocument, warnings: WarningCollector): Document {
  const state: State = { doc, warnings, footnotes: {}, nextFootnote: 1, nextListInstance: 1 };
  const { meta, template } = doc;
  const rtl = meta.direction === 'rtl';
  const font = fontOptions(doc);
  const halfPoints = Math.round(template.fontSizePt * 2);
  const page = PAGE_MM[template.pageSize];

  const children: (Paragraph | Table | TableOfContents)[] = [];
  if (template.coverPage) children.push(...coverChildren(state));
  if (template.tableOfContents) {
    children.push(...tocChildren(state));
    warnings.add('TOC_NEEDS_FIELD_UPDATE');
  }
  for (const block of doc.body) children.push(...blockChildren(block, state));
  children.push(...bibliographyChildren(state));

  const headingStyle = (level: number) => ({
    run: {
      font,
      bold: true,
      boldComplexScript: true,
      size: Math.round(halfPoints * (HEADING_SCALE[level - 1] ?? 1)),
      sizeComplexScript: Math.round(halfPoints * (HEADING_SCALE[level - 1] ?? 1)),
    },
    paragraph: { spacing: { before: 360, after: 120 }, keepNext: true, outlineLevel: level - 1 },
  });

  const pageNumberFooter = new Footer({
    children: [
      new Paragraph({
        alignment: AlignmentType.CENTER,
        children: [new TextRun({ children: [PageNumber.CURRENT], font, size: halfPoints - 4 })],
      }),
    ],
  });

  const listLevel = (format: (typeof LevelFormat)[keyof typeof LevelFormat], text: string) => ({
    level: 0,
    format,
    text,
    alignment: AlignmentType.START,
    style: { paragraph: { indent: { start: twips(10), hanging: twips(5) } } },
  });

  return new Document({
    title: meta.title,
    creator: meta.author,
    features: { updateFields: template.tableOfContents },
    styles: {
      default: {
        document: {
          run: {
            font,
            size: halfPoints,
            sizeComplexScript: halfPoints,
            language: { value: 'en-US', bidirectional: 'ar-SA' },
          },
          paragraph: { spacing: { line: Math.round(240 * template.lineSpacing), after: 120 } },
        },
        heading1: headingStyle(1),
        heading2: headingStyle(2),
        heading3: headingStyle(3),
        heading4: headingStyle(4),
        caption: {
          run: {
            font,
            size: halfPoints - 2,
            sizeComplexScript: halfPoints - 2,
            bold: true,
            boldComplexScript: true,
          },
        },
      },
      paragraphStyles: [
        {
          id: 'Quote',
          name: 'Quote',
          basedOn: 'Normal',
          run: { size: halfPoints - 2, sizeComplexScript: halfPoints - 2 },
        },
        ...[1, 2, 3, 4].map((level) => ({
          id: `TOC${level}`,
          name: `toc ${level}`,
          basedOn: 'Normal',
          paragraph: {
            ...(rtl ? { bidirectional: true } : {}),
            indent: { start: twips(6 * (level - 1)) },
          },
        })),
      ],
    },
    numbering: {
      config: [
        { reference: BULLET_REF, levels: [listLevel(LevelFormat.BULLET, '•')] },
        { reference: NUMBER_REF, levels: [listLevel(LevelFormat.DECIMAL, '%1.')] },
      ],
    },
    footnotes: state.footnotes,
    sections: [
      {
        properties: {
          titlePage: template.coverPage,
          page: {
            size: { width: twips(page.width), height: twips(page.height) },
            margin: {
              top: twips(template.margins.top),
              bottom: twips(template.margins.bottom),
              // Page margins are physical; start/end follow the document direction.
              right: twips(rtl ? template.margins.start : template.margins.end),
              left: twips(rtl ? template.margins.end : template.margins.start),
            },
          },
        },
        ...(template.pageNumbers
          ? {
              footers: {
                default: pageNumberFooter,
                // The cover page (title page) carries no page number.
                ...(template.coverPage
                  ? { first: new Footer({ children: [new Paragraph({ children: [] })] }) }
                  : {}),
              },
            }
          : {}),
        children,
      },
    ],
  });
}

/** Exports the document as a Word (.docx) file. */
export async function exportDocx(input: unknown): Promise<ExportResult> {
  const doc = parseExportDocument(input);
  const warnings = new WarningCollector();
  const document = buildDocx(doc, warnings);
  const packed = new Uint8Array(await Packer.toBuffer(document));
  const bytes = doc.meta.direction === 'rtl' ? addSectionBidi(packed) : packed;
  return {
    bytes,
    mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    filename: buildFilename(doc.meta.title, 'docx'),
    warnings: warnings.toArray(),
  };
}
