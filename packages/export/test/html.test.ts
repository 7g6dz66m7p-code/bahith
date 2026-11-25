import { describe, expect, it } from 'vitest';

import { exportHtml } from '../src';
import { CITATION_TEXT, ENGLISH_PARAGRAPH, sampleArabicDocument, TASHKEEL } from './fixtures';

const html = (input: unknown, fontPackages?: readonly string[]) => {
  const result = exportHtml(input, fontPackages === undefined ? {} : { fontPackages });
  return { result, text: new TextDecoder().decode(result.bytes) };
};

describe('exportHtml (the same HTML that is printed to PDF)', () => {
  const { result, text } = html(sampleArabicDocument());

  it('declares language and direction on the root and per block', () => {
    expect(result.mime).toBe('text/html; charset=utf-8');
    expect(text).toContain('<html lang="ar" dir="rtl">');
    expect(text).toContain(`<p dir="ltr">${ENGLISH_PARAGRAPH}</p>`);
    expect(text).toContain(`<p dir="rtl">${TASHKEEL}، <strong>وهذه جملة عريضة</strong>`);
  });

  it('is self-contained: CSP forbids scripts and network, fonts and images are inlined', () => {
    expect(text).toContain(
      `content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:"`,
    );
    expect(text).toMatch(
      /@font-face\{font-family:'Noto Naskh Arabic';[^}]*data:font\/woff2;base64,/u,
    );
    expect(text).toContain("font-family:'IBM Plex Sans Arabic'");
    expect(text).toContain('src="data:image/png;base64,');
    expect(text).not.toMatch(/<script|https?:\/\//u);
  });

  it('maps logical margins to physical @page margins and suppresses the cover number', () => {
    expect(text).toContain('@page{size:A4;margin:25mm 30mm 25mm 25mm;');
    expect(text).toContain('@bottom-center{content:counter(page);');
    expect(text).toContain('@page :first{@bottom-center{content:none;}}');
  });

  it('keeps citation metadata and text verbatim', () => {
    expect(text).toContain(
      `<span class="citation" dir="rtl" data-source-id="src-1" data-locator="ص. ١٥">${CITATION_TEXT}</span>`,
    );
  });

  it('collects footnotes at the end of each chapter with global numbering', () => {
    const chapterTwo = text.indexOf('الفصل الثاني: الإطار النظري</h1>');
    const firstNotes = text.indexOf('<section class="chapter-notes">');
    expect(firstNotes).toBeGreaterThan(-1);
    expect(firstNotes).toBeLessThan(chapterTwo);
    expect(text).toContain('<sup class="fnref"><a href="#fn-1" id="fnref-1">1</a></sup>');
    expect(text).toContain('<li id="fn-2" value="2" dir="rtl">حاشية الفصل الثاني.</li>');
    expect(result.warnings).toContainEqual({ code: 'FOOTNOTES_AS_CHAPTER_NOTES', count: 2 });
  });

  it('renders supported LaTeX as MathML and the rest as text with a warning', () => {
    expect(text).toContain(
      '<math display="block" alttext="\\frac{a}{b} + x^{2}"><mrow><mfrac><mi>a</mi><mi>b</mi></mfrac><mo>+</mo><msup><mi>x</mi><mn>2</mn></msup></mrow></math>',
    );
    expect(text).toContain('<code>matrix(a, b)</code>');
    expect(result.warnings).toContainEqual({ code: 'EQUATION_AS_TEXT', count: 1 });
  });

  it('escapes document text, so markup in it is never executed', () => {
    const { text: escaped } = html(
      sampleArabicDocument({
        body: [
          {
            type: 'paragraph',
            runs: [{ type: 'text', text: '<script>alert(1)</script> & "q" \'s' }],
          },
          { type: 'heading', level: 1, text: '<img src=x onerror=alert(1)>' },
        ],
      }),
    );
    expect(escaped).toContain('&lt;script&gt;alert(1)&lt;/script&gt; &amp; &quot;q&quot; &#39;s');
    expect(escaped).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(escaped).not.toContain('<script>');
  });

  it('does not embed SVG images (they can carry script) and says so', () => {
    const { result: svg, text: svgHtml } = html(
      sampleArabicDocument({
        body: [
          {
            type: 'image',
            data: new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>'),
            mime: 'image/svg+xml',
            alt: 'رسم',
          },
        ],
      }),
    );
    expect(svgHtml).not.toContain('data:image/svg');
    expect(svgHtml).toContain('[صورة غير مضمّنة: رسم]');
    expect(svg.warnings).toContainEqual({ code: 'IMAGE_SKIPPED', count: 1 });
  });

  it('falls back to system fonts with a warning when the font packages are missing', () => {
    const { result: fallback, text: fallbackHtml } = html(sampleArabicDocument(), [
      '@fontsource/this-package-does-not-exist',
    ]);
    expect(fallback.warnings).toContainEqual({ code: 'FONT_FALLBACK', count: 1 });
    expect(fallbackHtml).not.toContain('@font-face');
    expect(fallbackHtml).toContain("font-family:'Noto Naskh Arabic', serif");
  });
});
