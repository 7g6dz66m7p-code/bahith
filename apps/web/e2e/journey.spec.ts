import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { expect, test } from '@playwright/test';
import JSZip from 'jszip';

import ar from '../messages/ar.json' with { type: 'json' };
import en from '../messages/en.json' with { type: 'json' };

import { readVerificationUrl, resetRateLimits } from './helpers';

/**
 * The researcher's journey, entirely through the interface: sign up, verify the email,
 * sign in, create a project, upload a scanned source (real OCR worker), find evidence,
 * import references, write a draft citing the passage, and export DOCX. Synthetic data.
 */
const SCANNED_PDF = path.join(import.meta.dirname, 'fixtures/scanned-arabic.pdf');
const BIBTEX =
  '@book{journey,\n  title = {مناهج البحث العلمي},\n  author = {الباحث, سارة},\n  year = {2021}\n}\n';

test.beforeEach(async () => {
  await resetRateLimits();
});

test('from sign-up to an exported draft, through the interface only', async ({ page }, info) => {
  test.setTimeout(300_000);
  const locale = info.project.name.startsWith('ar') ? 'ar' : 'en';
  const m = locale === 'ar' ? ar : en;
  const identity = {
    name: locale === 'ar' ? 'باحثة الرحلة' : 'Journey researcher',
    email: `journey-${crypto.randomUUID()}@example.test`,
    password: `Journey-${crypto.randomUUID()}`,
  };

  // 1. Sign up, verify, sign in.
  await page.goto(`/${locale}/sign-up`);
  await page.getByLabel(m.Auth.name, { exact: true }).fill(identity.name);
  await page.getByLabel(m.Auth.email, { exact: true }).fill(identity.email);
  await page.getByLabel(m.Auth.password, { exact: true }).fill(identity.password);
  await page.getByLabel(m.Auth.confirmPassword, { exact: true }).fill(identity.password);
  await page.getByRole('button', { name: m.Auth.signUp, exact: true }).click();
  await expect(page.getByRole('status')).toHaveText(m.Auth.signUpSuccess);
  await page.goto(await readVerificationUrl(identity.email));
  await page.context().clearCookies();
  await page.goto(`/${locale}/sign-in`);
  await page.getByLabel(m.Auth.email, { exact: true }).fill(identity.email);
  await page.getByLabel(m.Auth.password, { exact: true }).fill(identity.password);
  await page.getByRole('button', { name: m.Auth.signIn, exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/${locale}/dashboard$`));

  // 2. Create a project and open it.
  await page.getByRole('button', { name: m.Dashboard.newProject, exact: true }).click();
  await page.getByLabel(m.Dashboard.projectTitle, { exact: true }).fill('أثر المصادر الأصلية');
  await page
    .getByLabel(m.Dashboard.researchQuestion, { exact: true })
    .fill('كيف تُحلَّل المصادر الأصلية؟');
  await page.getByRole('button', { name: m.Dashboard.createProject, exact: true }).click();
  await page.getByRole('link', { name: m.Dashboard.openProject }).first().click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('أثر المصادر الأصلية');

  // 3. Upload a scanned source; the real workers OCR and ingest it.
  await page.getByLabel(m.Project.uploadLabel).setInputFiles(SCANNED_PDF);
  await page.getByRole('button', { name: m.Project.upload }).click();
  await expect(page.getByTestId('file-status')).toHaveText(m.Project.statusReady, {
    timeout: 150_000,
  });

  // 4. Find evidence with its stored page.
  await page.getByLabel(m.Project.searchLabel).fill('المصادر الأصلية');
  await page.getByRole('button', { name: m.Project.search, exact: true }).click();
  await expect(page.getByTestId('evidence').first().getByTestId('evidence-page')).toHaveText(
    m.Project.page.replace('{page}', '1'),
  );

  // 5. Import a reference list.
  const references = page.locator('section[aria-labelledby="references-title"]');
  await references
    .getByLabel(m.References.importLabel)
    .setInputFiles({ name: 'refs.bib', mimeType: 'text/plain', buffer: Buffer.from(BIBTEX) });
  await references.getByRole('button', { name: m.References.import, exact: true }).click();
  await expect(
    references.getByRole('listitem').filter({ hasText: 'مناهج البحث العلمي' }),
  ).toBeVisible();

  // 6. Write a draft that cites the passage.
  await page.getByPlaceholder(m.Project.draftTitle).fill('الفصل الأول');
  await page.getByRole('button', { name: m.Project.createDraft }).click();
  const editor = page.getByRole('textbox', { name: m.Draft.editorLabel });
  await editor.click();
  await page.keyboard.type('تعتمد الدراسة على تحليل المصادر الأصلية ');
  await page.getByRole('button', { name: m.Draft.cite, exact: true }).click();
  await page.getByPlaceholder(m.Draft.citeSearch).fill('المصادر الأصلية');
  await page.getByRole('button', { name: m.Draft.search, exact: true }).click();
  await page.getByRole('button', { name: m.Draft.insertCitation }).first().click();
  await expect(editor.locator('[data-citation]')).toHaveCount(1);
  await expect(page.getByTestId('save-state')).toHaveText(m.Draft.save.saved, { timeout: 20_000 });

  // 7. Export DOCX: the text, right-to-left paragraphs and the reference list are in the file.
  const [docx] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: m.Draft.export.docx }).click(),
  ]);
  const xml =
    (await (
      await JSZip.loadAsync(await readFile(await docx.path()))
    )
      .file('word/document.xml')
      ?.async('string')) ?? '';
  expect(xml).toContain('تعتمد الدراسة على تحليل المصادر الأصلية');
  expect(xml).toContain('<w:bidi/>');
  expect(xml).toContain('scanned-arabic');
});
