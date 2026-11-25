import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { expect, test } from '@playwright/test';
import JSZip from 'jszip';
import { z } from 'zod';

import ar from '../messages/ar.json' with { type: 'json' };
import en from '../messages/en.json' with { type: 'json' };

import { registerAndVerify, resetRateLimits } from './helpers';

/**
 * Draft journey: upload a source → write an Arabic draft → cite an OCR'd passage →
 * footnote → autosave → reload → compare versions → export DOCX and PDF, then check the
 * DOCX XML itself (text, direction, real footnote, citation page from the stored passage).
 * All text is synthetic test content.
 */
const SCANNED_PDF = path.join(import.meta.dirname, 'fixtures/scanned-arabic.pdf');
const ORIGIN = { origin: 'http://localhost:3100' };

test.beforeEach(async () => {
  await resetRateLimits();
});

test('write, cite, autosave, compare versions and export a draft', async ({ page }, info) => {
  test.setTimeout(240_000);
  const locale = info.project.name.startsWith('ar') ? 'ar' : 'en';
  const messages = locale === 'ar' ? ar : en;
  const p = messages.Project;
  const d = messages.Draft;
  await registerAndVerify(page, locale, 'Draft fixture');

  const { workspaces } = z
    .object({ workspaces: z.array(z.object({ id: z.uuid() })) })
    .parse(await (await page.request.get('/api/projects')).json());
  const workspaceId = workspaces[0]?.id ?? '';
  const created = await page.request.post('/api/projects', {
    headers: ORIGIN,
    data: { workspaceId, title: 'مشروع المسودة', language: 'ar' },
  });
  const { project } = z.object({ project: z.object({ id: z.uuid() }) }).parse(await created.json());

  // A processed source to cite.
  await page.goto(`/${locale}/workspaces/${workspaceId}/projects/${project.id}`);
  await page.getByLabel(p.uploadLabel).setInputFiles(SCANNED_PDF);
  await page.getByRole('button', { name: p.upload }).click();
  await expect(page.getByTestId('file-status')).toHaveText(p.statusReady, { timeout: 120_000 });

  // Create a draft from the project page.
  await page.getByPlaceholder(p.draftTitle).fill('الفصل الأول: منهج الدراسة');
  await page.getByRole('button', { name: p.createDraft }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('الفصل الأول: منهج الدراسة');

  // Write: a chapter heading and an Arabic paragraph.
  const editor = page.getByRole('textbox', { name: d.editorLabel });
  await editor.click();
  await page.getByRole('button', { name: d.chapter, exact: true }).click();
  await page.keyboard.type('مقدمة الدراسة');
  await page.keyboard.press('Enter');
  await page.keyboard.type('تعتمد هذه الدراسة على المصادر الأصلية ');

  // Cite the OCR'd passage found through SANAD.
  await page.getByRole('button', { name: d.cite, exact: true }).click();
  await page.getByPlaceholder(d.citeSearch).fill('المصادر الأصلية');
  await page.getByRole('button', { name: d.search, exact: true }).click();
  await page.getByRole('button', { name: d.insertCitation }).first().click();
  await expect(editor.locator('[data-citation]')).toHaveCount(1);

  // A footnote.
  await page.getByRole('button', { name: d.footnote, exact: true }).click();
  await page.getByPlaceholder(d.footnoteText).fill('حاشية توضيحية للاختبار');
  await page.getByRole('button', { name: d.insertFootnote }).click();
  await expect(editor.locator('[data-footnote]')).toHaveCount(1);

  // Autosave (every 5 s), then reload: the content is still there.
  await expect(page.getByTestId('save-state')).toHaveText(d.save.saved, { timeout: 20_000 });
  await page.reload();
  await expect(editor).toContainText('تعتمد هذه الدراسة على المصادر الأصلية');
  await expect(editor.locator('h1')).toHaveText('مقدمة الدراسة');
  await expect(editor.locator('[data-citation]')).toHaveCount(1);
  await expect(editor.locator('p').first()).toHaveAttribute('dir', 'auto');

  // Version history: compare the first (empty) version with the current text.
  await page.getByRole('button', { name: d.versions, exact: true }).click();
  await page.getByRole('button', { name: d.compare }).last().click();
  await expect(page.getByTestId('version-diff').locator('ins')).toContainText('مقدمة الدراسة');

  // Export DOCX and inspect the file itself.
  const [docx] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: d.export.docx }).click(),
  ]);
  const zip = await JSZip.loadAsync(await readFile(await docx.path()));
  const documentXml = (await zip.file('word/document.xml')?.async('string')) ?? '';
  const footnotesXml = (await zip.file('word/footnotes.xml')?.async('string')) ?? '';
  expect(documentXml).toContain('تعتمد هذه الدراسة على المصادر الأصلية');
  expect(documentXml).toContain('مقدمة الدراسة');
  expect(documentXml).toContain('<w:bidi/>');
  expect(documentXml).toContain('w:footnoteReference');
  expect(footnotesXml).toContain('حاشية توضيحية للاختبار');
  // The citation was rebuilt from the stored source (its title) and passage (page 1).
  expect(documentXml).toContain('scanned-arabic');
  expect(documentXml).toMatch(/1/u);
  expect(documentXml).toContain('المصادر والمراجع');
  await expect(page.getByTestId('export-warning').first()).toBeVisible();

  // Export PDF: a real PDF document.
  const [pdf] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: d.export.pdf }).click(),
  ]);
  const bytes = await readFile(await pdf.path());
  expect(bytes.subarray(0, 5).toString()).toBe('%PDF-');
  expect(bytes.byteLength).toBeGreaterThan(5_000);
});

test('stale saves are refused and drafts are private to the project', async ({
  page,
  browser,
}, info) => {
  const locale = info.project.name.startsWith('ar') ? 'ar' : 'en';
  await registerAndVerify(page, locale, 'Draft API fixture');
  const { workspaces } = z
    .object({ workspaces: z.array(z.object({ id: z.uuid() })) })
    .parse(await (await page.request.get('/api/projects')).json());
  const workspaceId = workspaces[0]?.id ?? '';
  const { project } = z.object({ project: z.object({ id: z.uuid() }) }).parse(
    await (
      await page.request.post('/api/projects', {
        headers: ORIGIN,
        data: { workspaceId, title: 'مسودات خاصة', language: locale },
      })
    ).json(),
  );
  const base = `/api/projects/${project.id}/documents`;
  const q = `?workspaceId=${workspaceId}`;
  const { document } = z
    .object({ document: z.object({ id: z.uuid() }) })
    .parse(
      await (
        await page.request.post(`${base}${q}`, { headers: ORIGIN, data: { title: 'مسودة' } })
      ).json(),
    );
  const content = (text: string) => ({
    type: 'doc',
    content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
  });
  const put = (text: string, baseVersion: number) =>
    page.request.put(`${base}/${document.id}${q}`, {
      headers: ORIGIN,
      data: { content: content(text), baseVersion },
    });
  expect((await put('النسخة الثانية', 1)).status()).toBe(200);
  expect((await put('تبويب قديم', 1)).status()).toBe(409);

  const outsider = await browser.newContext({ baseURL: 'http://localhost:3100' });
  try {
    await registerAndVerify(await outsider.newPage(), locale, 'Draft outsider');
    expect((await outsider.request.get(`${base}/${document.id}${q}`)).status()).toBe(403);
    expect(
      (await outsider.request.get(`${base}/${document.id}/export${q}&format=docx`)).status(),
    ).toBe(403);
    expect(
      (
        await outsider.request.put(`${base}/${document.id}${q}`, {
          headers: ORIGIN,
          data: { content: content('دخيل'), baseVersion: 2 },
        })
      ).status(),
    ).toBe(403);
  } finally {
    await outsider.close();
  }
});
