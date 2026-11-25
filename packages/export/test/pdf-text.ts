import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';

export interface PdfItem {
  str: string;
  /** Left edge and baseline in PDF points (origin bottom-left). */
  x: number;
  y: number;
  width: number;
}

export interface PdfLine {
  text: string;
  /** Horizontal extent of the line's glyphs, in PDF points from the left page edge. */
  left: number;
  right: number;
}

export interface PdfPage {
  items: PdfItem[];
  /** Reconstructed lines in logical (reading) order; see `buildLines`. */
  lines: PdfLine[];
  /** All lines joined with "\n". */
  text: string;
}

export interface PdfContent {
  pageCount: number;
  pages: PdfPage[];
  /** Bookmark titles (from Chromium's `outline: true`), depth-first. */
  outline: string[];
}

const RTL = /[֐-ࣿיִ-﷿ﹰ-ﻼ]/u;
const MARKS_ONLY = /^\p{M}+$/u;

/**
 * Normalises extracted text for comparison: NFKC folds Arabic presentation forms
 * (e.g. U+FEF7 lam-alef-hamza → لأ) to logical letters; combining marks (tashkeel) are
 * dropped because their extracted position is not reliable, as are control characters
 * (pdf.js yields U+0000 for stacked-mark glyphs that have no Unicode mapping);
 * whitespace is collapsed.
 */
export function normalizeExtracted(text: string): string {
  return text
    .normalize('NFKC')
    .replace(/[\p{M}\p{Cc}]/gu, (char) => (char === '\n' ? char : ''))
    .replace(/\s+/gu, ' ')
    .trim();
}

/**
 * PDF content streams hold glyphs in visual (left-to-right) order. A line is rebuilt
 * in reading order from glyph geometry: items on one baseline, sorted right-to-left
 * when the line contains Arabic, left-to-right otherwise. Arabic therefore only reads
 * correctly if Chromium really laid it out right-to-left — which is what is tested.
 */
function buildLines(items: readonly PdfItem[]): PdfLine[] {
  const glyphs = items.filter((item) => item.str.length > 0 && !MARKS_ONLY.test(item.str));
  const rows: { y: number; items: PdfItem[] }[] = [];
  for (const item of [...glyphs].sort((a, b) => b.y - a.y)) {
    const row = rows.find((candidate) => Math.abs(candidate.y - item.y) <= 3);
    if (row === undefined) rows.push({ y: item.y, items: [item] });
    else row.items.push(item);
  }
  return rows.map((row) => {
    const rtl = row.items.some((item) => RTL.test(item.str));
    const centre = (item: PdfItem) => item.x + item.width / 2;
    const ordered = [...row.items].sort((a, b) =>
      rtl ? centre(b) - centre(a) : centre(a) - centre(b),
    );
    const visible = row.items.filter((item) => item.str.trim().length > 0);
    return {
      text: normalizeExtracted(ordered.map((item) => item.str).join('')),
      left: Math.min(...visible.map((item) => item.x)),
      right: Math.max(...visible.map((item) => item.x + item.width)),
    };
  });
}

/**
 * Chromium wraps each shaped glyph cluster in a marked-content `Span` (with /ActualText,
 * which pdf.js does not read). A ligature such as بي is one glyph whose ToUnicode string
 * is already logical, but pdf.js runs its bidi reversal on it anyway; undo that for
 * single-cluster items. Multi-glyph items outside a Span are left as pdf.js ordered them.
 */
function clusterText(str: string, inSpan: boolean): string {
  const chars = Array.from(str);
  return inSpan && chars.length > 1 && RTL.test(str) ? chars.reverse().join('') : str;
}

/** Extracts text with pdf.js (legacy build, for Node), plus the outline. */
export async function extractPdf(bytes: Uint8Array): Promise<PdfContent> {
  // pdf.js transfers (detaches) the buffer it is given; pass a copy.
  const task = getDocument({ data: new Uint8Array(bytes), verbosity: 0 });
  try {
    const pdf = await task.promise;
    const pages: PdfPage[] = [];
    for (let i = 1; i <= pdf.numPages; i += 1) {
      const page = await pdf.getPage(i);
      const content = await page.getTextContent({ includeMarkedContent: true });
      const items: PdfItem[] = [];
      const tags: string[] = [];
      for (const item of content.items) {
        if (!('str' in item)) {
          if (item.type === 'endMarkedContent') tags.pop();
          // `tag` exists at runtime but is missing from pdf.js's TextMarkedContent type.
          else tags.push('tag' in item && typeof item.tag === 'string' ? item.tag : '');
          continue;
        }
        const transform = item.transform as number[];
        items.push({
          str: clusterText(item.str, tags.includes('Span')),
          x: transform[4] ?? 0,
          y: transform[5] ?? 0,
          width: item.width,
        });
      }
      const lines = buildLines(items);
      pages.push({ items, lines, text: lines.map((line) => line.text).join('\n') });
    }
    const outline: string[] = [];
    const walk = (nodes: readonly { title: string; items: readonly unknown[] }[]) => {
      for (const node of nodes) {
        outline.push(node.title);
        walk(node.items as { title: string; items: readonly unknown[] }[]);
      }
    };
    // Typed as an array, but pdf.js resolves to null when the PDF has no outline.
    const tree: unknown = await pdf.getOutline();
    walk(Array.isArray(tree) ? (tree as { title: string; items: readonly unknown[] }[]) : []);
    return { pageCount: pdf.numPages, pages, outline };
  } finally {
    await task.destroy();
  }
}
