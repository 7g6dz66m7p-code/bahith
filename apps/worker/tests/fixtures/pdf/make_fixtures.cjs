// Regenerates born-digital PDF fixtures with Chromium (Skia/HarfBuzz shaping, the same
// kind of producer as most browser-made and many word-processor PDFs).
// Usage: node apps/worker/tests/fixtures/pdf/make_fixtures.cjs
// The sentences are synthetic test content written for these tests.
const path = require('node:path');
const { chromium } = require('playwright');

const lines = [
  ['rtl', 'ar', 'تعتمد الدراسة على تحليل المصادر الأصلية في البحث العلمي.'],
  [
    'rtl',
    'ar',
    'أظهرت النتائج أن التعليم عن بعد يرفع التحصيل بنسبة ١٢٪ لدى طلاب المرحلة الثانوية.',
  ],
  ['rtl', 'ar', 'نشرت الدراسة في مجلة Nature عام 2015 بعنوان Deep Learning وهي مرجع مهم.'],
  ['rtl', 'ar', 'انظر المرجع (الفصل الثالث، ص 45) لمزيد من التفصيل.'],
  ['ltr', 'en', 'The study (Smith, 2020, p. 45) reports that 37% of participants improved.'],
  ['ltr', 'en', 'Mixed: the term الإسناد means chain of transmission in hadith studies.'],
];

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const body = lines
    .map(([dir, lang, text]) => `<p dir="${dir}" lang="${lang}">${text}</p>`)
    .join('\n');
  await page.setContent(
    `<html><body style="font-family:'DejaVu Sans';font-size:15px">${body}</body></html>`,
  );
  await page.pdf({ path: path.join(__dirname, 'arabic-english-mixed.pdf'), format: 'A4' });
  await browser.close();
})();
