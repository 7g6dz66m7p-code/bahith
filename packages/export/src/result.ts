/**
 * Warning codes: each says what a format could not represent faithfully, so the UI can
 * show the researcher an honest list before they download the file.
 */
export type ExportWarningCode =
  /** An equation was written as text (LaTeX source or its fallback) instead of math. */
  | 'EQUATION_AS_TEXT'
  /** An image was left out (format cannot embed it, or its type/size is unsupported). */
  | 'IMAGE_SKIPPED'
  /** HTML/PDF: footnotes are collected at the end of each chapter, not at the page foot. */
  | 'FOOTNOTES_AS_CHAPTER_NOTES'
  /** HTML/PDF: the bundled Arabic web fonts were not found; system fonts were used. */
  | 'FONT_FALLBACK'
  /** HTML/PDF: the table of contents lists headings without page numbers. */
  | 'TOC_WITHOUT_PAGE_NUMBERS'
  /** DOCX: the TOC is a field; Word fills page numbers when it updates fields on open. */
  | 'TOC_NEEDS_FIELD_UPDATE'
  /** PDF: no bookmarks, because Chromium writes RTL bookmark titles in visual word order. */
  | 'PDF_BOOKMARKS_OMITTED';

export interface ExportWarning {
  code: ExportWarningCode;
  count: number;
}

export interface ExportResult {
  bytes: Uint8Array;
  mime: string;
  filename: string;
  warnings: ExportWarning[];
}

export type ExportFormat = 'docx' | 'pdf' | 'html' | 'markdown' | 'latex';

/** Accumulates warnings by code, in first-seen order. */
export class WarningCollector {
  readonly #counts = new Map<ExportWarningCode, number>();

  add(code: ExportWarningCode, count = 1): void {
    if (count <= 0) return;
    this.#counts.set(code, (this.#counts.get(code) ?? 0) + count);
  }

  toArray(): ExportWarning[] {
    return [...this.#counts].map(([code, count]) => ({ code, count }));
  }
}

const EXTENSIONS: Record<ExportFormat, string> = {
  docx: 'docx',
  pdf: 'pdf',
  html: 'html',
  markdown: 'md',
  latex: 'tex',
};

/**
 * A filesystem-safe filename from the title, keeping Arabic letters (marks stripped
 * so the name stays readable in file managers), falling back to `document`.
 */
export function buildFilename(title: string, format: ExportFormat): string {
  const stem = title
    .normalize('NFC')
    .replace(/[\p{M}ـ]/gu, '')
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, 80)
    .replace(/-+$/u, '');
  return `${stem.length > 0 ? stem : 'document'}.${EXTENSIONS[format]}`;
}
