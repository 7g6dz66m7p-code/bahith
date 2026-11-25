import { type Browser, chromium } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { type ExportResult, exportPdf } from '../src';
import {
  arabicTemplate,
  ENGLISH_PARAGRAPH,
  FOOTNOTE_TEXT,
  sampleArabicDocument,
  TASHKEEL,
} from './fixtures';
import { extractPdf, normalizeExtracted, type PdfContent } from './pdf-text';

/*
 * Two renderings of the same document:
 * - with Noto Naskh Arabic (the template default), checked through the PDF outline,
 *   embedded font names and page-number glyphs;
 * - with IBM Plex Sans Arabic, checked through the page text. Noto Naskh draws dotted
 *   letters as a dotless base plus separate dot glyphs; Chromium then records the real
 *   letters only in /ActualText spans, which pdf.js does not read. IBM Plex maps one
 *   glyph to one letter, so pdf.js can recover the text and its reading order.
 */
let browser: Browser;
let naskh: ExportResult;
let naskhPdf: PdfContent;
let plex: ExportResult;
let plexPdf: PdfContent;

beforeAll(async () => {
  browser = await chromium.launch();
  naskh = await exportPdf(sampleArabicDocument(), { browser });
  naskhPdf = await extractPdf(naskh.bytes);
  plex = await exportPdf(
    sampleArabicDocument({ template: { ...arabicTemplate, fontFamily: 'IBM Plex Sans Arabic' } }),
    { browser },
  );
  plexPdf = await extractPdf(plex.bytes);
}, 60_000);

afterAll(async () => {
  await browser.close();
});

const allText = (pdf: PdfContent) => pdf.pages.map((page) => page.text).join('\n');

/**
 * Letters and their order are compared exactly; whitespace is not, because pdf.js
 * infers spaces from glyph gaps (Arabic letters that do not join leave such gaps).
 */
const squash = (text: string) => normalizeExtracted(text).replace(/\s+/gu, '');
function expectPhrase(text: string | undefined, phrase: string): void {
  expect(squash(text ?? '')).toContain(squash(phrase));
}

describe('exportPdf (Playwright Chromium)', () => {
  it('returns a PDF', () => {
    expect(naskh.mime).toBe('application/pdf');
    expect(naskh.filename).toBe('أثر-التعلم-المدمج-في-التحصيل.pdf');
    expect(Buffer.from(naskh.bytes.subarray(0, 5)).toString('latin1')).toBe('%PDF-');
    // cover, TOC, chapter 1, chapter 2, references
    expect(naskhPdf.pageCount).toBe(5);
  });

  it('embeds the bundled Arabic font', () => {
    expect(Buffer.from(naskh.bytes).includes('NotoNaskhArabic-Regular')).toBe(true);
    expect(Buffer.from(plex.bytes).includes('IBMPlexSansArabic')).toBe(true);
    expect(naskh.warnings.map((warning) => warning.code)).not.toContain('FONT_FALLBACK');
  });

  it('omits bookmarks for RTL headings (Chromium reverses their words) and says so', () => {
    expect(naskhPdf.outline).toEqual([]);
    expect(naskh.warnings).toContainEqual({ code: 'PDF_BOOKMARKS_OMITTED', count: 1 });
  });

  it('writes bookmarks in document order for an LTR document', async () => {
    const base = sampleArabicDocument();
    const result = await exportPdf(
      {
        ...base,
        meta: { ...base.meta, title: 'Blended learning', language: 'en', direction: 'ltr' },
        body: [
          { type: 'heading', level: 1, text: 'Chapter One: Introduction' },
          { type: 'paragraph', runs: [{ type: 'text', text: ENGLISH_PARAGRAPH }] },
          { type: 'heading', level: 2, text: 'Problem statement' },
        ],
        bibliography: { heading: 'References', entries: [] },
      },
      { browser },
    );
    const pdf = await extractPdf(result.bytes);
    expect(pdf.outline).toEqual(['Chapter One: Introduction', 'Problem statement', 'References']);
    expect(result.warnings.map((warning) => warning.code)).not.toContain('PDF_BOOKMARKS_OMITTED');
  });

  it('lays Arabic out right-to-left: reading glyphs right-to-left gives the logical text', () => {
    const text = allText(plexPdf);
    for (const phrase of [
      'الفصل الأول: مقدمة الدراسة',
      'وهذه جملة عريضة تتبعها جملة مائلة',
      'نص مقتبس تجريبي يوضع بين علامتي تنصيص.',
      'المطلب الأول: أسئلة الدراسة',
      'جامعة تجريبية',
    ]) {
      expectPhrase(text, phrase);
    }
    // The vocalised sentence is there with its letters in order (marks compared separately).
    expectPhrase(text, TASHKEEL);
    const marks = plexPdf.pages.flatMap((page) => page.items.map((item) => item.str)).join('');
    // Tashkeel is drawn: fatha, kasra and sukun glyphs map back to their code points.
    // (Shadda+fatha is one stacked glyph without a Unicode mapping in this font.)
    for (const mark of ['\u064E', '\u0650', '\u0652']) expect(marks).toContain(mark);
  });

  it('keeps an English LTR paragraph in left-to-right order', () => {
    expect(allText(plexPdf)).toContain(ENGLISH_PARAGRAPH);
  });

  it('aligns RTL paragraphs to the right margin and the LTR paragraph to the left', () => {
    // A4 is 595.28pt wide; template margins: start (right, RTL) 30mm, end (left) 25mm.
    const mm = 72 / 25.4;
    const rightEdge = 595.28 - 30 * mm;
    const leftEdge = 25 * mm;
    // Body pages only (the TOC indents its entries).
    const lines = plexPdf.pages.slice(2).flatMap((page) => page.lines);
    const line = (text: string) =>
      lines.find((candidate) => squash(candidate.text).includes(squash(text)));
    const heading = line('المبحث الأول: مشكلة الدراسة');
    const subsection = line('المطلب الأول: أسئلة الدراسة');
    const english = line(ENGLISH_PARAGRAPH);
    expect(heading?.right).toBeCloseTo(rightEdge, -0.5);
    expect(subsection?.right).toBeCloseTo(rightEdge, -0.5);
    expect(english?.left).toBeCloseTo(leftEdge, -0.5);
    // …and the English line does not reach the right margin.
    expect(english?.right ?? 0).toBeLessThan(rightEdge - 20);
  });

  it('prints footnotes as numbered notes at the end of each chapter, and says so', () => {
    const chapterOne = plexPdf.pages.find(
      (page) => page.text.includes('مقدمة الدراسة') && page.text.includes('الحواشي'),
    );
    expectPhrase(chapterOne?.text, FOOTNOTE_TEXT);
    const chapterTwo = plexPdf.pages.find(
      (page) => page.text.includes('الإطار النظري') && !page.text.includes('المحتويات'),
    );
    expectPhrase(chapterTwo?.text, 'حاشية الفصل الثاني.');
    expect(plex.warnings).toContainEqual({ code: 'FOOTNOTES_AS_CHAPTER_NOTES', count: 2 });
  });

  it('prints page numbers in the footer, except on the cover page', () => {
    const footerNumbers = naskhPdf.pages.map((page) =>
      page.items
        .filter((item) => item.y < 60 && /^\d+$/u.test(item.str.trim()))
        .map((item) => item.str.trim()),
    );
    expect(footerNumbers[0]).toEqual([]);
    for (let i = 1; i < naskhPdf.pageCount; i += 1) {
      expect(footerNumbers[i]).toEqual([String(i + 1)]);
    }
  });

  it('prints the cover, the table of contents and the bibliography verbatim', () => {
    const [cover, toc] = plexPdf.pages;
    expectPhrase(cover?.text, 'إعداد: باحث تجريبي');
    expectPhrase(cover?.text, 'إشراف: مشرف تجريبي');
    expectPhrase(toc?.text, 'المحتويات');
    expectPhrase(toc?.text, 'المبحث الأول: مشكلة الدراسة');
    const last = plexPdf.pages.at(-1)?.text ?? '';
    expect(last).toContain('Author, A. (2019). A fictitious English reference. Test Press.');
    expect(plex.warnings).toContainEqual({ code: 'TOC_WITHOUT_PAGE_NUMBERS', count: 1 });
    expect(plex.warnings).toContainEqual({ code: 'EQUATION_AS_TEXT', count: 1 });
  });

  it('launches and closes its own browser when none is given', async () => {
    const result = await exportPdf(
      sampleArabicDocument({
        template: {
          ...arabicTemplate,
          coverPage: false,
          tableOfContents: false,
          pageNumbers: false,
        },
        body: [{ type: 'paragraph', runs: [{ type: 'text', text: 'فقرة واحدة' }] }],
      }),
    );
    const pdf = await extractPdf(result.bytes);
    expect(pdf.pageCount).toBe(2); // body + references
    expect(pdf.pages.flatMap((page) => page.items).some((item) => item.y < 60)).toBe(false);
  });
});
