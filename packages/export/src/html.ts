import { loadEmbeddedFonts } from './fonts';
import { displaySize, isHtmlEmbeddable, toDataUri } from './image';
import { parseLatexMath, toMathML } from './math';
import type { Block, Direction, ExportDocument, Inline, NoteRun } from './model';
import { parseExportDocument } from './model';
import { buildFilename, type ExportResult, WarningCollector } from './result';
import { autoDirection, blockDirection, collectHeadings, label } from './text';

export interface HtmlOptions {
  /** Fontsource packages to inline; defaults to Noto Naskh Arabic + IBM Plex Sans Arabic. */
  fontPackages?: readonly string[];
}

export const escapeHtml = (value: string): string =>
  value
    .replace(/&/gu, '&amp;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;')
    .replace(/"/gu, '&quot;')
    .replace(/'/gu, '&#39;');

const MM_PER_PX = 25.4 / 96;

interface RenderState {
  doc: ExportDocument;
  warnings: WarningCollector;
  footnoteNumber: number;
  /** Footnotes waiting to be printed at the end of the current chapter. */
  pendingNotes: { n: number; html: string; dir: Direction }[];
  headingIds: Map<Block, string>;
}

function noteRunsHtml(runs: readonly NoteRun[], state: RenderState): string {
  return runs.map((run) => inlineHtml(run, state)).join('');
}

function inlineHtml(run: Inline, state: RenderState): string {
  switch (run.type) {
    case 'text': {
      let html = escapeHtml(run.text);
      if (run.italic === true) html = `<em>${html}</em>`;
      if (run.bold === true) html = `<strong>${html}</strong>`;
      return html;
    }
    case 'citation': {
      const locator = run.locator === undefined ? '' : ` data-locator="${escapeHtml(run.locator)}"`;
      const dir = autoDirection(run.text, state.doc.meta.direction);
      return `<span class="citation" dir="${dir}" data-source-id="${escapeHtml(run.sourceId)}"${locator}>${escapeHtml(run.text)}</span>`;
    }
    case 'footnote': {
      state.footnoteNumber += 1;
      const n = state.footnoteNumber;
      const content = noteRunsHtml(run.content, state);
      const firstText = run.content.map((part) => part.text).join('');
      state.pendingNotes.push({
        n,
        html: content,
        dir: autoDirection(firstText, state.doc.meta.direction),
      });
      return `<sup class="fnref"><a href="#fn-${n}" id="fnref-${n}">${n}</a></sup>`;
    }
  }
}

function runsHtml(runs: readonly Inline[], state: RenderState): string {
  return runs.map((run) => inlineHtml(run, state)).join('');
}

function flushNotes(state: RenderState): string {
  if (state.pendingNotes.length === 0) return '';
  const { language } = state.doc.meta;
  const items = state.pendingNotes
    .map((note) => `<li id="fn-${note.n}" value="${note.n}" dir="${note.dir}">${note.html}</li>`)
    .join('');
  state.pendingNotes = [];
  return `<section class="chapter-notes"><p class="notes-title">${escapeHtml(label(language, 'notes'))}</p><ol>${items}</ol></section>`;
}

function blockHtml(block: Block, state: RenderState): string {
  const dir = blockDirection(block, state.doc);
  switch (block.type) {
    case 'heading': {
      const notes = block.level === 1 ? flushNotes(state) : '';
      const id = state.headingIds.get(block) ?? '';
      return `${notes}<h${block.level} id="${id}" dir="${dir}">${escapeHtml(block.text)}</h${block.level}>`;
    }
    case 'paragraph':
      return `<p dir="${dir}">${runsHtml(block.runs, state)}</p>`;
    case 'blockquote':
      return `<blockquote dir="${dir}"><p>${runsHtml(block.runs, state)}</p></blockquote>`;
    case 'list': {
      const tag = block.ordered ? 'ol' : 'ul';
      const items = block.items.map((item) => `<li>${runsHtml(item, state)}</li>`).join('');
      return `<${tag} dir="${dir}">${items}</${tag}>`;
    }
    case 'table': {
      const caption =
        block.caption === undefined ? '' : `<caption>${escapeHtml(block.caption)}</caption>`;
      const head = block.header.map((cell) => `<th scope="col">${escapeHtml(cell)}</th>`).join('');
      const body = block.rows
        .map((row) => `<tr>${row.map((cell) => `<td>${escapeHtml(cell)}</td>`).join('')}</tr>`)
        .join('');
      return `<table dir="${dir}">${caption}<thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
    }
    case 'image': {
      const caption =
        block.caption === undefined ? '' : `<figcaption>${escapeHtml(block.caption)}</figcaption>`;
      if (!isHtmlEmbeddable(block.mime)) {
        state.warnings.add('IMAGE_SKIPPED');
        const text = label(state.doc.meta.language, 'imageOmitted', { alt: block.alt });
        return `<figure dir="${dir}"><p class="image-omitted">${escapeHtml(text)}</p>${caption}</figure>`;
      }
      const { margins, pageSize } = state.doc.template;
      const pageWidthMm = pageSize === 'A4' ? 210 : 215.9;
      const size = displaySize(block, (pageWidthMm - margins.start - margins.end) / MM_PER_PX);
      const dims = size === undefined ? '' : ` width="${size.width}" height="${size.height}"`;
      return `<figure dir="${dir}"><img src="${toDataUri(block)}" alt="${escapeHtml(block.alt)}"${dims}>${caption}</figure>`;
    }
    case 'equation': {
      const nodes = parseLatexMath(block.latex);
      if (nodes !== undefined)
        return `<div class="equation" dir="ltr">${toMathML(nodes, block.latex)}</div>`;
      state.warnings.add('EQUATION_AS_TEXT');
      return `<div class="equation equation-text" dir="ltr"><code>${escapeHtml(block.fallbackText ?? block.latex)}</code></div>`;
    }
  }
}

function coverHtml(doc: ExportDocument): string {
  const { meta } = doc;
  const line = (cls: string, value: string | undefined) =>
    value === undefined || value.trim() === '' ? '' : `<p class="${cls}">${escapeHtml(value)}</p>`;
  return [
    '<section class="cover">',
    line('cover-institution', meta.institution),
    line('cover-department', meta.department),
    `<p class="cover-title">${escapeHtml(meta.title)}</p>`,
    line('cover-subtitle', meta.subtitle),
    line('cover-degree', meta.degree),
    line('cover-author', `${label(meta.language, 'preparedBy')}: ${meta.author}`),
    meta.supervisor === undefined
      ? ''
      : line('cover-supervisor', `${label(meta.language, 'supervisedBy')}: ${meta.supervisor}`),
    line('cover-date', meta.date),
    '</section>',
  ].join('');
}

function tocHtml(doc: ExportDocument, headingIds: Map<Block, string>): string {
  const items = doc.body
    .filter((block) => block.type === 'heading')
    .map(
      (block) =>
        `<li class="toc-${block.level}"><a href="#${headingIds.get(block) ?? ''}">${escapeHtml(block.text)}</a></li>`,
    );
  items.push(
    `<li class="toc-1"><a href="#bibliography">${escapeHtml(doc.bibliography.heading)}</a></li>`,
  );
  return `<nav class="toc"><p class="toc-title">${escapeHtml(label(doc.meta.language, 'tableOfContents'))}</p><ol>${items.join('')}</ol></nav>`;
}

function styles(doc: ExportDocument, fontCss: string, families: readonly string[]): string {
  const { template, meta } = doc;
  const rtl = meta.direction === 'rtl';
  // @page margins are physical; map the logical start/end through the direction.
  const left = rtl ? template.margins.end : template.margins.start;
  const right = rtl ? template.margins.start : template.margins.end;
  const fontStack = [template.fontFamily, ...families]
    .map((family) => `'${family}'`)
    .concat(['serif'])
    .join(', ');
  const size = template.pageSize === 'A4' ? 'A4' : 'letter';
  const pageNumber = template.pageNumbers
    ? `@bottom-center{content:counter(page);font-family:${fontStack};font-size:${Math.max(template.fontSizePt - 2, 8)}pt;}`
    : '';
  const firstPage =
    template.pageNumbers && template.coverPage ? '@page :first{@bottom-center{content:none;}}' : '';
  return `${fontCss}
@page{size:${size};margin:${template.margins.top}mm ${right}mm ${template.margins.bottom}mm ${left}mm;${pageNumber}}
${firstPage}
html{font-family:${fontStack};font-size:${template.fontSizePt}pt;line-height:${template.lineSpacing};}
body{margin:0;color:#000;background:#fff;}
p{margin-block:0 0.6em;text-align:justify;}
h1,h2,h3,h4{line-height:1.3;break-after:avoid;margin-block:1em 0.5em;}
h1{font-size:1.6em;break-before:page;}
h2{font-size:1.35em;}
h3{font-size:1.15em;}
h4{font-size:1em;}
.cover{break-after:page;text-align:center;min-height:90vh;display:flex;flex-direction:column;justify-content:center;gap:0.8em;}
.cover p{text-align:center;margin:0;}
.cover-title{font-size:2em;font-weight:700;}
.cover-subtitle{font-size:1.3em;}
.toc{break-after:page;}
.toc-title,.notes-title{font-weight:700;font-size:1.2em;}
.toc ol{list-style:none;padding:0;margin:0;}
.toc a{color:inherit;text-decoration:none;}
.toc-2{padding-inline-start:1.5em;}
.toc-3{padding-inline-start:3em;}
.toc-4{padding-inline-start:4.5em;}
blockquote{margin-block:0.8em;margin-inline:2em;font-size:0.95em;}
table{border-collapse:collapse;width:100%;margin-block:0.8em;break-inside:avoid;}
caption{font-weight:700;margin-block-end:0.3em;}
th,td{border:1px solid #444;padding:0.2em 0.4em;text-align:start;vertical-align:top;}
figure{margin-block:0.8em;margin-inline:0;text-align:center;break-inside:avoid;}
figure img{max-width:100%;height:auto;}
figcaption{font-size:0.9em;}
.equation{text-align:center;margin-block:0.8em;}
.equation-text code{font-family:'DejaVu Sans Mono',monospace;font-size:0.9em;}
.citation{unicode-bidi:isolate;}
.fnref{font-size:0.7em;line-height:0;}
.fnref a{color:inherit;text-decoration:none;}
.chapter-notes{border-block-start:1px solid #444;margin-block-start:1.5em;padding-block-start:0.4em;font-size:0.85em;}
.chapter-notes ol{margin:0;padding-inline-start:2em;}
.bibliography{break-before:page;}
.bibliography .ref{padding-inline-start:2em;text-indent:-2em;text-align:start;}
`;
}

/**
 * Renders the self-contained HTML used both as the HTML export and as the PDF source.
 * All document text is escaped; no scripts, no external resources (enforced by CSP).
 */
export function renderHtml(
  doc: ExportDocument,
  warnings: WarningCollector,
  options: HtmlOptions = {},
): string {
  const fonts = loadEmbeddedFonts(options.fontPackages);
  if (fonts.families.length === 0) warnings.add('FONT_FALLBACK');

  const headingIds = new Map<Block, string>(
    collectHeadings(doc).map((entry) => [entry.block, entry.id]),
  );
  const state: RenderState = { doc, warnings, footnoteNumber: 0, pendingNotes: [], headingIds };
  const { meta, template } = doc;

  const parts: string[] = [];
  if (template.coverPage) parts.push(coverHtml(doc));
  if (template.tableOfContents) {
    parts.push(tocHtml(doc, headingIds));
    warnings.add('TOC_WITHOUT_PAGE_NUMBERS');
  }
  parts.push('<main>');
  for (const block of doc.body) parts.push(blockHtml(block, state));
  parts.push(flushNotes(state));
  parts.push('</main>');
  if (state.footnoteNumber > 0) warnings.add('FOOTNOTES_AS_CHAPTER_NOTES', state.footnoteNumber);

  const entries = doc.bibliography.entries
    .map(
      (entry) =>
        `<p class="ref" dir="${autoDirection(entry, meta.direction)}">${escapeHtml(entry)}</p>`,
    )
    .join('');
  parts.push(
    `<section class="bibliography"><h1 id="bibliography">${escapeHtml(doc.bibliography.heading)}</h1>${entries}</section>`,
  );

  return [
    '<!doctype html>',
    `<html lang="${meta.language}" dir="${meta.direction}">`,
    '<head>',
    '<meta charset="utf-8">',
    `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:">`,
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${escapeHtml(meta.title)}</title>`,
    `<meta name="author" content="${escapeHtml(meta.author)}">`,
    `<style>${styles(doc, fonts.css, fonts.families)}</style>`,
    '</head>',
    `<body>${parts.join('')}</body>`,
    '</html>',
  ].join('\n');
}

/** Exports the document as one self-contained HTML file (fonts and images inlined). */
export function exportHtml(input: unknown, options: HtmlOptions = {}): ExportResult {
  const doc = parseExportDocument(input);
  const warnings = new WarningCollector();
  const html = renderHtml(doc, warnings, options);
  return {
    bytes: new TextEncoder().encode(html),
    mime: 'text/html; charset=utf-8',
    filename: buildFilename(doc.meta.title, 'html'),
    warnings: warnings.toArray(),
  };
}
