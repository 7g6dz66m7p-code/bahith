import type { CitationTarget } from '@bahith/db';
import type { Block, ExportDocument, Inline, NoteRun } from '@bahith/export';

/**
 * Converts an editor draft (Tiptap/ProseMirror JSON) into the export model.
 *
 * Integrity rules (engineering rule 9) are enforced here, not trusted from the editor:
 *  - citation text and page numbers are produced by the citation engine from the stored
 *    source record and the stored passage pages (`CitationTarget`), never from the node;
 *  - the bibliography lists exactly the sources cited in the draft, formatted by code.
 */

export interface DraftNode {
  type: string;
  attrs?: Record<string, unknown>;
  content?: DraftNode[];
  marks?: { type: string }[];
  text?: string;
}

export interface CitationRef {
  sourceId: string;
  chunkId: string | null;
}

/** Every citation in the draft (main text and footnotes), in reading order. */
export function collectCitations(doc: DraftNode): CitationRef[] {
  const refs: CitationRef[] = [];
  const walk = (node: DraftNode) => {
    if (node.type === 'citation') {
      const sourceId = node.attrs?.sourceId;
      const chunkId = node.attrs?.chunkId;
      if (typeof sourceId === 'string') {
        refs.push({ sourceId, chunkId: typeof chunkId === 'string' ? chunkId : null });
      }
    }
    for (const child of node.content ?? []) walk(child);
  };
  walk(doc);
  return refs;
}

export type FormatCitation = (target: CitationTarget) => string;

const STRONG_RTL = /[\u0590-\u08FF\uFB1D-\uFDFF\uFE70-\uFEFC]/u;
const STRONG_LTR = /[A-Za-z\u00C0-\u024F]/u;

/** Paragraph direction: explicit attribute, else the first strong character, else the document's. */
function directionOf(node: DraftNode, text: string, fallback: 'rtl' | 'ltr'): 'rtl' | 'ltr' {
  const dir = node.attrs?.dir;
  if (dir === 'rtl' || dir === 'ltr') return dir;
  for (const char of text) {
    if (STRONG_RTL.test(char)) return 'rtl';
    if (STRONG_LTR.test(char)) return 'ltr';
  }
  return fallback;
}

function plainText(node: DraftNode): string {
  if (node.type === 'text') return node.text ?? '';
  if (node.type === 'hardBreak') return '\n';
  return (node.content ?? []).map(plainText).join('');
}

export interface ConvertOptions {
  direction: 'rtl' | 'ltr';
  /** Formats one in-text citation from its resolved target. */
  formatCitation: FormatCitation;
  /** Resolved targets keyed by `${sourceId}:${chunkId ?? ''}`. */
  targets: Map<string, CitationTarget>;
}

export const targetKey = (ref: CitationRef) => `${ref.sourceId}:${ref.chunkId ?? ''}`;

function citationRun(node: DraftNode, options: ConvertOptions): Inline | null {
  const sourceId = node.attrs?.sourceId;
  if (typeof sourceId !== 'string') return null;
  const chunkId = typeof node.attrs?.chunkId === 'string' ? node.attrs.chunkId : null;
  const target = options.targets.get(targetKey({ sourceId, chunkId }));
  if (target === undefined) return null;
  const page = target.chunk?.pageStart ?? null;
  return {
    type: 'citation',
    text: options.formatCitation(target),
    sourceId,
    ...(page === null ? {} : { locator: String(page) }),
  };
}

function inlineRuns(node: DraftNode, options: ConvertOptions): Inline[] {
  const runs: Inline[] = [];
  for (const child of node.content ?? []) {
    if (child.type === 'text') {
      const marks = new Set((child.marks ?? []).map((mark) => mark.type));
      runs.push({
        type: 'text',
        text: child.text ?? '',
        ...(marks.has('bold') ? { bold: true } : {}),
        ...(marks.has('italic') ? { italic: true } : {}),
      });
    } else if (child.type === 'hardBreak') {
      runs.push({ type: 'text', text: '\n' });
    } else if (child.type === 'citation') {
      const run = citationRun(child, options);
      if (run !== null) runs.push(run);
    } else if (child.type === 'footnote') {
      const text = typeof child.attrs?.text === 'string' ? child.attrs.text.trim() : '';
      if (text !== '') {
        const content: NoteRun[] = [{ type: 'text', text }];
        runs.push({ type: 'footnote', content });
      }
    }
  }
  return runs;
}

function convertBlock(node: DraftNode, options: ConvertOptions): Block[] {
  switch (node.type) {
    case 'heading': {
      const text = plainText(node).trim();
      if (text === '') return [];
      const level = Math.min(4, Math.max(1, Number(node.attrs?.level ?? 1)));
      return [{ type: 'heading', level, text, dir: directionOf(node, text, options.direction) }];
    }
    case 'paragraph': {
      const runs = inlineRuns(node, options);
      if (runs.length === 0) return [];
      return [
        { type: 'paragraph', runs, dir: directionOf(node, plainText(node), options.direction) },
      ];
    }
    case 'blockquote': {
      const runs = (node.content ?? []).flatMap((child, index) => [
        ...(index > 0 ? [{ type: 'text' as const, text: '\n' }] : []),
        ...inlineRuns(child, options),
      ]);
      if (runs.length === 0) return [];
      return [
        { type: 'blockquote', runs, dir: directionOf(node, plainText(node), options.direction) },
      ];
    }
    case 'bulletList':
    case 'orderedList': {
      const items = (node.content ?? [])
        .map((item) => (item.content ?? []).flatMap((child) => inlineRuns(child, options)))
        .filter((runs) => runs.length > 0);
      if (items.length === 0) return [];
      return [
        {
          type: 'list',
          ordered: node.type === 'orderedList',
          items,
          dir: directionOf(node, plainText(node), options.direction),
        },
      ];
    }
    case 'table': {
      const rows = (node.content ?? []).map((row) =>
        (row.content ?? []).map((cell) => plainText(cell).trim()),
      );
      const [header, ...body] = rows;
      if (header === undefined || header.length === 0) return [];
      const width = header.length;
      return [
        {
          type: 'table',
          header,
          rows: body.map((row) => Array.from({ length: width }, (_, index) => row[index] ?? '')),
          dir: directionOf(node, plainText(node), options.direction),
        },
      ];
    }
    default:
      return [];
  }
}

export interface DraftExportInput {
  doc: DraftNode;
  title: string;
  author: string;
  language: 'ar' | 'en';
  bibliographyHeading: string;
  bibliography: string[];
  formatCitation: FormatCitation;
  targets: Map<string, CitationTarget>;
}

export function draftToExportDocument(input: DraftExportInput): ExportDocument {
  const direction = input.language === 'ar' ? 'rtl' : 'ltr';
  const options: ConvertOptions = {
    direction,
    formatCitation: input.formatCitation,
    targets: input.targets,
  };
  return {
    meta: { title: input.title, author: input.author, language: input.language, direction },
    template: {
      id: input.language === 'ar' ? 'bahith-thesis-ar' : 'bahith-thesis-en',
      pageSize: 'A4',
      margins: { top: 25, bottom: 25, start: 30, end: 25 },
      fontFamily: input.language === 'ar' ? 'Noto Naskh Arabic' : 'IBM Plex Sans Arabic',
      fontSizePt: input.language === 'ar' ? 14 : 12,
      lineSpacing: 1.5,
      coverPage: true,
      tableOfContents: true,
      pageNumbers: true,
    },
    body: (input.doc.content ?? []).flatMap((node) => convertBlock(node, options)),
    bibliography: { heading: input.bibliographyHeading, entries: input.bibliography },
  };
}
