import { describe, expect, it } from 'vitest';

import { exportDocx } from '../src';
import { openDocx, paragraphWith, paragraphs, runs } from './docx-helpers';
import {
  CITATION_TEXT,
  ENGLISH_PARAGRAPH,
  FOOTNOTE_TEXT,
  sampleArabicDocument,
  TASHKEEL,
} from './fixtures';

describe('exportDocx — Arabic RTL inside word/document.xml', async () => {
  const doc = sampleArabicDocument();
  const result = await exportDocx(doc);
  const docx = await openDocx(result.bytes);

  it('returns a .docx with the Word MIME type and an Arabic filename', () => {
    expect(result.mime).toBe(
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    );
    expect(result.filename).toBe('أثر-التعلم-المدمج-في-التحصيل.docx');
    // A zip (PK\x03\x04) that JSZip, a different implementation from the writer, opens.
    expect([...result.bytes.subarray(0, 4)]).toEqual([0x50, 0x4b, 0x03, 0x04]);
  });

  it('keeps the vocalised Arabic text byte-for-byte (no Unicode normalisation)', () => {
    expect(TASHKEEL).not.toBe(TASHKEEL.normalize('NFC')); // the fixture is order-sensitive
    const needle = Buffer.from(TASHKEEL, 'utf8');
    expect(Buffer.from(docx.documentBytes).indexOf(needle)).toBeGreaterThan(-1);
    expect(docx.document).toContain(`<w:t xml:space="preserve">${TASHKEEL}، </w:t>`);
  });

  it('marks RTL paragraphs with <w:bidi/> and Arabic runs with <w:rtl/> and a cs font', () => {
    const paragraph = paragraphWith(docx.document, TASHKEEL);
    expect(paragraph).toMatch(/<w:pPr>[^]*<w:bidi\/>[^]*<\/w:pPr>/u);
    const arabicRun = runs(paragraph).find((run) => run.includes(TASHKEEL)) ?? '';
    expect(arabicRun).toContain('<w:rtl/>');
    expect(arabicRun).toMatch(/<w:rFonts [^>]*w:cs="Noto Naskh Arabic"/u);
    expect(arabicRun).toContain('<w:szCs w:val="28"/>');
    const boldRun = runs(paragraph).find((run) => run.includes('وهذه جملة عريضة')) ?? '';
    expect(boldRun).toContain('<w:b/>');
    expect(boldRun).toContain('<w:bCs/>');
    expect(boldRun).toContain('<w:rtl/>');
  });

  it('does not put bidi or rtl on an English LTR paragraph', () => {
    const paragraph = paragraphWith(docx.document, ENGLISH_PARAGRAPH);
    expect(paragraph).not.toContain('<w:bidi/>');
    expect(paragraph).not.toContain('<w:rtl/>');
  });

  it('sets the section itself right-to-left', () => {
    const sectPr = /<w:sectPr>[^]*<\/w:sectPr>/u.exec(docx.document)?.[0] ?? '';
    expect(sectPr).toContain('<w:bidi/>');
    // Schema order: titlePg … bidi … docGrid.
    expect(sectPr.indexOf('<w:titlePg/>')).toBeLessThan(sectPr.indexOf('<w:bidi/>'));
    expect(sectPr.indexOf('<w:bidi/>')).toBeLessThan(sectPr.indexOf('<w:docGrid'));
  });

  it('writes the citation display text verbatim', () => {
    expect(docx.document).toContain(`<w:t xml:space="preserve">${CITATION_TEXT}</w:t>`);
  });

  it('writes real Word footnotes: references in the body, content in footnotes.xml', () => {
    expect(docx.document).toContain('<w:footnoteReference w:id="1"/>');
    expect(docx.document).toContain('<w:footnoteReference w:id="2"/>');
    const note = /<w:footnote w:id="1">[^]*?<\/w:footnote>/u.exec(docx.footnotes)?.[0] ?? '';
    expect(note).toContain(FOOTNOTE_TEXT);
    expect(note).toContain('<w:bidi/>');
    expect(note).toContain('<w:rtl/>');
    expect(docx.footnotes).toContain('حاشية الفصل الثاني.');
  });

  it('puts a PAGE field in the footer and leaves the cover page unnumbered', () => {
    const numbered = docx.footers.filter((footer) =>
      /<w:instrText[^>]*>\s*PAGE\s*<\/w:instrText>/u.test(footer),
    );
    expect(numbered).toHaveLength(1);
    expect(docx.footers).toHaveLength(2); // default (numbered) + first page (empty)
    expect(docx.document).toContain('<w:footerReference w:type="default"');
    expect(docx.document).toContain('<w:footerReference w:type="first"');
    expect(docx.document).toContain('<w:titlePg/>');
  });

  it('emits a TOC field Word updates on open, with the static heading list as cached result', () => {
    expect(docx.document).toMatch(/<w:instrText[^>]*>TOC \\h \\o &quot;1-4&quot;<\/w:instrText>/u);
    const toc = /<w:sdtContent>[^]*?<\/w:sdtContent>/u.exec(docx.document)?.[0] ?? '';
    for (const heading of [
      'الفصل الأول: مقدمة الدراسة',
      'المبحث الأول: مشكلة الدراسة',
      'المطلب الأول: أسئلة الدراسة',
      'الفصل الثاني: الإطار النظري',
      'المراجع',
    ]) {
      expect(toc).toContain(heading);
    }
    expect(docx.settings).toContain('<w:updateFields/>');
    expect(result.warnings).toContainEqual({ code: 'TOC_NEEDS_FIELD_UPDATE', count: 1 });
  });

  it('uses Word heading styles for chapter / section / subsection', () => {
    // After the TOC field, whose cached result repeats the heading texts.
    const body = docx.document.slice(docx.document.indexOf('</w:sdt>'));
    expect(paragraphWith(body, 'مقدمة الدراسة</w:t>')).toContain('<w:pStyle w:val="Heading1"/>');
    expect(paragraphWith(body, 'مشكلة الدراسة</w:t>')).toContain('<w:pStyle w:val="Heading2"/>');
    expect(paragraphWith(body, 'أسئلة الدراسة</w:t>')).toContain('<w:pStyle w:val="Heading3"/>');
    // Later chapters start on a new page; the first follows the TOC's page break.
    expect(paragraphWith(body, 'الإطار النظري</w:t>')).toContain('<w:pageBreakBefore/>');
    expect(paragraphWith(body, 'مقدمة الدراسة</w:t>')).not.toContain('<w:pageBreakBefore/>');
    for (const id of ['Heading1', 'Heading2', 'Heading3', 'Heading4']) {
      expect(docx.styles).toContain(`w:styleId="${id}"`);
    }
  });

  it('builds the cover page from the metadata', () => {
    const cover = docx.document.slice(0, docx.document.indexOf('<w:sdt>'));
    for (const text of [
      'جامعة تجريبية',
      'أثر التعلم المدمج في التحصيل',
      'إعداد: باحث تجريبي',
      'إشراف: مشرف تجريبي',
    ]) {
      expect(cover).toContain(text);
    }
    expect(cover).toContain('<w:br w:type="page"/>');
  });

  it('writes an RTL table with a repeated header row', () => {
    const table = /<w:tbl>[^]*?<\/w:tbl>/u.exec(docx.document)?.[0] ?? '';
    expect(table).toContain('<w:bidiVisual/>');
    expect(table).toContain('<w:tblHeader/>');
    expect(table).toContain('المتغير');
    expect(table).toContain('٦ أشهر');
  });

  it('numbers ordered lists and bullets unordered ones, each list restarting', () => {
    const items = paragraphs(docx.document).filter((p) => p.includes('<w:numPr>'));
    expect(items).toHaveLength(4);
    const numIds = items.map((p) => /<w:numId w:val="(\d+)"\/>/u.exec(p)?.[1]);
    expect(numIds[0]).toBe(numIds[1]);
    expect(numIds[2]).toBe(numIds[3]);
    expect(numIds[0]).not.toBe(numIds[2]);
  });

  it('embeds the PNG with its alt text', () => {
    expect(Object.keys(docx.zip.files).some((name) => name.startsWith('word/media/'))).toBe(true);
    expect(docx.document).toContain('descr="شكل تجريبي"');
  });

  it('writes supported LaTeX as OMML and warns for the equation it cannot convert', () => {
    expect(docx.document).toContain('<m:oMath>');
    expect(docx.document).toMatch(/<m:f>[^]*<m:num>[^]*a[^]*<m:den>[^]*b/u);
    expect(docx.document).toContain('<m:sSup>');
    expect(docx.document).toContain('matrix(a, b)');
    expect(result.warnings).toContainEqual({ code: 'EQUATION_AS_TEXT', count: 1 });
  });

  it('copies bibliography entries verbatim, each in its own direction', () => {
    const arabic = paragraphWith(docx.document, 'عنوان كتاب تجريبي');
    const english = paragraphWith(docx.document, 'A fictitious English reference');
    expect(arabic).toContain('<w:bidi/>');
    expect(english).not.toContain('<w:bidi/>');
    expect(english).not.toContain('<w:rtl/>');
    expect(docx.document).toContain(
      'Author, A. (2019). A fictitious English reference. Test Press.',
    );
  });

  it('marks only the Arabic part of a mixed run as right-to-left', async () => {
    const mixed = sampleArabicDocument({
      body: [{ type: 'paragraph', runs: [{ type: 'text', text: 'يرى Smith أن المنهج مناسب' }] }],
    });
    const xml = (await openDocx((await exportDocx(mixed)).bytes)).document;
    const parts = runs(paragraphWith(xml, 'Smith'));
    const latin = parts.find((run) => run.includes('Smith')) ?? '';
    expect(latin).not.toContain('<w:rtl/>');
    expect(parts.filter((run) => run.includes('<w:rtl/>'))).toHaveLength(2);
    // Concatenated runs give back the exact input text.
    const text = parts.map((run) => /<w:t[^>]*>([^<]*)<\/w:t>/u.exec(run)?.[1] ?? '').join('');
    expect(text).toBe('يرى Smith أن المنهج مناسب');
  });
});

describe('exportDocx — English LTR document', async () => {
  const base = sampleArabicDocument();
  const result = await exportDocx({
    ...base,
    meta: { ...base.meta, title: 'Blended learning', language: 'en', direction: 'ltr' },
    template: {
      ...base.template,
      coverPage: false,
      tableOfContents: false,
      fontFamily: 'Times New Roman',
    },
    body: [
      { type: 'heading', level: 1, text: 'Introduction' },
      { type: 'paragraph', runs: [{ type: 'text', text: ENGLISH_PARAGRAPH }] },
    ],
    bibliography: {
      heading: 'References',
      entries: ['Author, A. (2019). A fictitious English reference. Test Press.'],
    },
  });
  const docx = await openDocx(result.bytes);

  it('carries no bidi markup anywhere', () => {
    expect(docx.document).not.toContain('<w:bidi/>');
    expect(docx.document).not.toContain('<w:rtl/>');
    expect(docx.document).not.toContain('<w:titlePg/>');
    expect(docx.document).not.toContain('TOC \\h');
    expect(result.warnings).toEqual([]);
  });

  it('keeps the page-number footer', () => {
    expect(docx.footers.some((footer) => footer.includes('PAGE'))).toBe(true);
  });
});
