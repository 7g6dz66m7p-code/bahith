// Regenerates the OCR test images with Chromium (correct Arabic shaping).
// Usage: node apps/worker/tests/fixtures/ocr/make_fixtures.cjs
// The text is synthetic test content written for these tests, not a research source.
const path = require('node:path');
const { chromium } = require('playwright');

const pages = {
  'arabic-page.png': {
    dir: 'rtl',
    lang: 'ar',
    text: 'المنهج العلمي في البحث<br>تعتمد الدراسة على تحليل المصادر الأصلية',
  },
  'english-page.png': {
    dir: 'ltr',
    lang: 'en',
    text: 'Scientific method in research<br>The study relies on primary sources',
  },
};

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({
    viewport: { width: 1400, height: 500 },
    deviceScaleFactor: 1,
  });
  for (const [file, spec] of Object.entries(pages)) {
    await page.setContent(
      `<html lang="${spec.lang}" dir="${spec.dir}"><body style="margin:60px;background:#fff;color:#000;` +
        `font-family:'DejaVu Sans',sans-serif;font-size:44px;line-height:1.8">${spec.text}</body></html>`,
    );
    await page.screenshot({ path: path.join(__dirname, file) });
  }
  await browser.close();
})();
