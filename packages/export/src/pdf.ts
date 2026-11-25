import { type Browser, chromium } from 'playwright';

import { ExportError } from './errors';
import { type HtmlOptions, renderHtml } from './html';
import { type ExportDocument, parseExportDocument } from './model';
import { buildFilename, type ExportResult, WarningCollector } from './result';

export interface PdfOptions extends HtmlOptions {
  /**
   * A running Chromium to reuse (it is left open). Without it, one is launched and
   * closed for this export.
   */
  browser?: Browser;
  /** Upper bound for loading and printing, in milliseconds (default 120 s). */
  timeoutMs?: number;
}

const RTL_LETTER = /[\u0590-\u08FF\uFB1D-\uFDFF\uFE70-\uFEFC]/u;

/**
 * Chromium (153) writes PDF bookmark titles of right-to-left headings with their words
 * in visual order ("الدراسة مقدمة: الأول الفصل"). A wrong bookmark is worse than none,
 * so the outline is only generated when no heading contains right-to-left text.
 */
function outlineIsSafe(doc: ExportDocument): boolean {
  const titles = [
    doc.bibliography.heading,
    ...doc.body.flatMap((b) => (b.type === 'heading' ? [b.text] : [])),
  ];
  return !titles.some((title) => RTL_LETTER.test(title));
}

/**
 * Exports the document to PDF by printing the shared HTML in headless Chromium.
 *
 * - Margins, page size and page numbers come from CSS paged media (`@page` margin
 *   boxes with `counter(page)`), so the cover page can be left unnumbered.
 * - Chromium has no per-page footnote layout: footnotes are printed at the end of each
 *   chapter (warning `FOOTNOTES_AS_CHAPTER_NOTES`).
 * - The page runs with network requests aborted; the HTML is self-contained.
 */
export async function exportPdf(input: unknown, options: PdfOptions = {}): Promise<ExportResult> {
  const doc = parseExportDocument(input);
  const warnings = new WarningCollector();
  const html = renderHtml(doc, warnings, options);
  const timeout = options.timeoutMs ?? 120_000;
  const outline = outlineIsSafe(doc);
  if (!outline) warnings.add('PDF_BOOKMARKS_OMITTED');

  let browser = options.browser;
  const ownsBrowser = browser === undefined;
  if (browser === undefined) {
    try {
      // Container images ship the distribution's Chromium (PDF_CHROMIUM_PATH); locally,
      // Playwright's own browser is used.
      const executablePath = process.env.PDF_CHROMIUM_PATH?.trim();
      browser = await chromium.launch(
        executablePath === undefined || executablePath === '' ? {} : { executablePath },
      );
    } catch (error) {
      throw new ExportError('EXPORT_RENDERER_UNAVAILABLE', { cause: error });
    }
  }

  try {
    const context = await browser.newContext();
    try {
      await context.route('**/*', (route) => route.abort());
      const page = await context.newPage();
      page.setDefaultTimeout(timeout);
      await page.setContent(html, { waitUntil: 'load', timeout });
      // Wait for the inlined web fonts, so glyphs are not printed with a fallback font.
      await page.evaluate('document.fonts.ready.then(() => true)');
      const pdf = await page.pdf({
        preferCSSPageSize: true,
        printBackground: true,
        outline,
        tagged: true,
      });
      return {
        bytes: new Uint8Array(pdf.buffer, pdf.byteOffset, pdf.byteLength),
        mime: 'application/pdf',
        filename: buildFilename(doc.meta.title, 'pdf'),
        warnings: warnings.toArray(),
      };
    } finally {
      await context.close();
    }
  } catch (error) {
    if (error instanceof ExportError) throw error;
    throw new ExportError('EXPORT_RENDER_FAILED', { cause: error });
  } finally {
    if (ownsBrowser) await browser.close();
  }
}
