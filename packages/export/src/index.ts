/**
 * @bahith/export — academic document export (DOCX, PDF, HTML, Markdown, LaTeX) from a
 * structured, validated document model. Arabic-first: RTL, complex-script fonts and
 * tashkeel are preserved in the produced files.
 *
 * References are never generated here: citation display text and bibliography entries
 * arrive pre-formatted from the citation engine and are copied verbatim.
 * BibTeX/RIS live in another package.
 */
import { exportDocx } from './docx';
import { exportHtml, type HtmlOptions } from './html';
import { exportLatex } from './latex';
import { exportMarkdown } from './markdown';
import { exportPdf, type PdfOptions } from './pdf';
import type { ExportFormat, ExportResult } from './result';

export { buildDocx, exportDocx } from './docx';
export { ExportError } from './errors';
export type { ExportErrorCode, ExportIssue } from './errors';
export { DEFAULT_FONT_PACKAGES, loadEmbeddedFonts } from './fonts';
export type { EmbeddedFonts } from './fonts';
export { escapeHtml, exportHtml, renderHtml } from './html';
export type { HtmlOptions } from './html';
export { escapeLatex, exportLatex, isSafeLatexMath, renderLatex } from './latex';
export { escapeMarkdown, exportMarkdown, renderMarkdown } from './markdown';
export { parseLatexMath, toMathML } from './math';
export type { MathNode } from './math';
export { exportDocumentSchema, parseExportDocument } from './model';
export type {
  Bibliography,
  Block,
  BlockquoteBlock,
  CitationRun,
  Direction,
  EquationBlock,
  ExportDocument,
  ExportMeta,
  ExportTemplate,
  FootnoteRun,
  HeadingBlock,
  ImageBlock,
  Inline,
  Language,
  ListBlock,
  NoteRun,
  ParagraphBlock,
  TableBlock,
  TextRun,
} from './model';
export { exportPdf } from './pdf';
export type { PdfOptions } from './pdf';
export { buildFilename, WarningCollector } from './result';
export type { ExportFormat, ExportResult, ExportWarning, ExportWarningCode } from './result';
export { splitByDirection } from './text';

export type ExportOptions = HtmlOptions & PdfOptions;

/** Exports `input` (validated here) in the requested format. */
export async function exportDocument(
  input: unknown,
  format: ExportFormat,
  options: ExportOptions = {},
): Promise<ExportResult> {
  switch (format) {
    case 'docx':
      return exportDocx(input);
    case 'pdf':
      return exportPdf(input, options);
    case 'html':
      return exportHtml(input, options);
    case 'markdown':
      return exportMarkdown(input);
    case 'latex':
      return exportLatex(input);
  }
}
