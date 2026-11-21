/**
 * Renders the synthetic corpus (corpus/corpus.json) to the committed PDFs:
 * born-digital PDFs with Chromium text, and image-only "scanned" PDFs (each page
 * a 150-dpi screenshot) for the OCR path. Re-run only when corpus.json changes.
 */
import { writeFile } from 'node:fs/promises';
import path from 'node:path';

import { chromium } from 'playwright';

import { CORPUS_DIR, loadCorpus } from './corpus-schema';

const escape = (text: string) =>
  text.replace(/[&<>"]/gu, (char) => `&#${String(char.codePointAt(0))};`);

const corpus = await loadCorpus();
const browser = await chromium.launch();
try {
  for (const document of corpus.documents) {
    const pages = document.pages.map(
      (paragraphs) =>
        `<section>${paragraphs
          .map((text) => `<p dir="${document.dir}" lang="${document.lang}">${escape(text)}</p>`)
          .join('')}</section>`,
    );
    const style =
      "body{margin:0;font-family:'DejaVu Sans';font-size:16px;line-height:1.7}" +
      'section{box-sizing:border-box;width:210mm;height:297mm;padding:25mm 20mm;' +
      'page-break-after:always;overflow:hidden}p{margin:0 0 14px}';
    const html = `<html><head><style>${style}</style></head><body>${pages.join('')}</body></html>`;
    const target = path.join(CORPUS_DIR, document.fileName);
    // Scanned pages: 794×1123 CSS px is A4 at 96 dpi; scale 1.5625 gives 150-dpi images.
    const page = await browser.newPage(
      document.scanned ? { viewport: { width: 794, height: 1123 }, deviceScaleFactor: 1.5625 } : {},
    );
    if (!document.scanned) {
      await page.setContent(html);
      await page.pdf({ path: target, format: 'A4', printBackground: true });
    } else {
      const images: string[] = [];
      for (const section of pages) {
        await page.setContent(
          `<html><head><style>${style}</style></head><body>${section}</body></html>`,
        );
        const shot = await page.screenshot({ type: 'png', scale: 'device' });
        images.push(shot.toString('base64'));
      }
      await page.setContent(
        '<html><head><style>body{margin:0}img{display:block;width:210mm;height:297mm;' +
          'page-break-after:always}</style></head><body>' +
          images.map((data) => `<img src="data:image/png;base64,${data}">`).join('') +
          '</body></html>',
      );
      await page.pdf({ path: target, format: 'A4' });
    }
    await page.close();
    process.stdout.write(`wrote ${path.relative(process.cwd(), target)}\n`);
  }
} finally {
  await browser.close();
}
await writeFile(
  path.join(CORPUS_DIR, 'README.md'),
  '# SANAD evaluation corpus\n\nSynthetic test documents generated from `corpus.json` by ' +
    '`pnpm --filter @bahith/eval eval:corpus`. They are not real studies and must never be ' +
    'cited.\n',
);
