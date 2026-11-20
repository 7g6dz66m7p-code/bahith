import { describe, expect, it } from 'vitest';

import { exportDocx, exportPdf } from '../src';
import { count, openDocx } from './docx-helpers';
import { arabicTemplate, syntheticThesis } from './fixtures';
import { extractPdf, normalizeExtracted } from './pdf-text';

/*
 * A ~30-page Arabic thesis built from SYNTHETIC filler text (see fixtures.ts):
 * 5 chapters × 3 sections × 2 subsections, 120 paragraphs, one footnote each.
 */
const thesis = syntheticThesis();
const headings = thesis.body.flatMap((block) => (block.type === 'heading' ? [block] : []));
const squash = (text: string) => normalizeExtracted(text).replace(/\s+/gu, '');

describe('long Arabic thesis', () => {
  it('exports to DOCX quickly with every heading and footnote intact', async () => {
    const started = performance.now();
    const result = await exportDocx(thesis);
    const elapsed = performance.now() - started;
    expect(elapsed).toBeLessThan(15_000);

    const docx = await openDocx(result.bytes);
    expect(count(docx.document, '<w:pStyle w:val="Heading1"/>')).toBe(5 + 1); // + bibliography
    expect(count(docx.document, '<w:pStyle w:val="Heading2"/>')).toBe(15);
    expect(count(docx.document, '<w:pStyle w:val="Heading3"/>')).toBe(30);
    for (const heading of headings) expect(docx.document).toContain(heading.text);

    expect(count(docx.document, /<w:footnoteReference w:id="\d+"\/>/u)).toBe(120);
    // 120 notes plus Word's two separator notes (ids -1 and 0).
    expect(count(docx.footnotes, /<w:footnote [^>]*w:id="/u)).toBe(122);
    expect(docx.footnotes).toContain('حاشية تجريبية رقم 1.');
    expect(docx.footnotes).toContain('حاشية تجريبية رقم 120.');
  }, 30_000);

  it('exports to PDF (~30 pages) with headings and footnotes in the text', async () => {
    const started = performance.now();
    // IBM Plex Sans Arabic so pdf.js can map glyphs back to letters (see pdf.test.ts).
    const result = await exportPdf({
      ...thesis,
      template: { ...arabicTemplate, fontFamily: 'IBM Plex Sans Arabic' },
    });
    const elapsed = performance.now() - started;
    expect(elapsed).toBeLessThan(60_000);

    const pdf = await extractPdf(result.bytes);
    expect(pdf.pageCount).toBeGreaterThanOrEqual(28);
    expect(pdf.pageCount).toBeLessThanOrEqual(45);

    // Body pages only: the table of contents repeats every heading.
    const body = squash(
      pdf.pages
        .slice(3)
        .map((page) => page.text)
        .join('\n'),
    );
    for (const heading of headings) expect(body).toContain(squash(heading.text));
    expect(body.split(squash('حاشية تجريبية رقم')).length - 1).toBe(120);
    expect(result.warnings).toContainEqual({ code: 'FOOTNOTES_AS_CHAPTER_NOTES', count: 120 });

    // Every page after the cover carries its number in the footer.
    for (let i = 1; i < pdf.pageCount; i += 1) {
      const footer = pdf.pages[i]?.items
        .filter((item) => item.y < 60)
        .map((item) => item.str.trim());
      expect(footer).toContain(String(i + 1));
    }
  }, 90_000);
});
