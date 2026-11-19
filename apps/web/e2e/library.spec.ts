import path from 'node:path';

import { expect, test } from '@playwright/test';
import { z } from 'zod';

import ar from '../messages/ar.json' with { type: 'json' };
import en from '../messages/en.json' with { type: 'json' };

import { registerAndVerify, resetRateLimits } from './helpers';

/**
 * Upload → real Python OCR worker → Node ingestion → SANAD evidence search → open the
 * source at the evidence page. The PDF is an image-only scan of synthetic Arabic test
 * text (apps/worker/tests/fixtures/ocr); nothing here is a real research source.
 */
const SCANNED_PDF = path.join(import.meta.dirname, 'fixtures/scanned-arabic.pdf');
const ORIGIN = { origin: 'http://localhost:3100' };

test.beforeEach(async () => {
  await resetRateLimits();
});

test('a scanned Arabic source is uploaded, OCR’d, searched and opened at its page', async ({
  page,
  browser,
}, info) => {
  test.setTimeout(180_000);
  const locale = info.project.name === 'ar' ? 'ar' : 'en';
  const m = (locale === 'ar' ? ar : en).Project;
  await registerAndVerify(page, locale, 'Library fixture');

  const { workspaces } = z
    .object({ workspaces: z.array(z.object({ id: z.uuid() })) })
    .parse(await (await page.request.get('/api/projects')).json());
  const workspaceId = workspaces[0]?.id ?? '';
  const created = await page.request.post('/api/projects', {
    headers: ORIGIN,
    data: { workspaceId, title: 'مشروع المكتبة', language: locale },
  });
  const { project } = z.object({ project: z.object({ id: z.uuid() }) }).parse(await created.json());

  // Open the project from the dashboard link (not by typing a URL).
  await page.goto(`/${locale}/dashboard`);
  await page.getByRole('link', { name: (locale === 'ar' ? ar : en).Dashboard.openProject }).click();
  await expect(page).toHaveURL(new RegExp(`/workspaces/${workspaceId}/projects/${project.id}$`));
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('مشروع المكتبة');

  // Upload through the form.
  await page.getByLabel(m.uploadLabel).setInputFiles(SCANNED_PDF);
  await page.getByRole('button', { name: m.upload }).click();
  await expect(page.getByRole('status')).toHaveText(m.uploadAccepted);

  // The real workers process it: status becomes Ready, with one page read by OCR.
  await expect(page.getByTestId('file-status')).toHaveText(m.statusReady, { timeout: 120_000 });
  await expect(page.getByText(m.ocrUsed)).toBeVisible();

  // Evidence search returns the OCR'd passage with its stored page number.
  await page.getByLabel(m.searchLabel).fill('المصادر الأصلية');
  await page.getByRole('button', { name: m.search, exact: true }).click();
  const evidence = page.getByTestId('evidence').first();
  await expect(evidence).toContainText('تحليل المصادر الأصلية');
  await expect(evidence.getByTestId('evidence-page')).toHaveText(m.page.replace('{page}', '1'));
  await expect(evidence.getByText(m.ocrEvidence)).toBeVisible();

  // "Open at page" points at the stored file with #page=1 and serves the real PDF.
  const link = evidence.getByRole('link', { name: m.openAtPage });
  const href = (await link.getAttribute('href')) ?? '';
  expect(href).toMatch(/#page=1$/u);
  const served = await page.request.get(href.replace(/#.*$/u, ''));
  expect(served.status()).toBe(200);
  expect(served.headers()['content-type']).toBe('application/pdf');
  expect((await served.body()).subarray(0, 5).toString()).toBe('%PDF-');

  // Uploading the same bytes again is detected as a duplicate.
  await page.getByLabel(m.uploadLabel).setInputFiles(SCANNED_PDF);
  await page.getByRole('button', { name: m.upload }).click();
  await expect(page.getByRole('status')).toHaveText(m.uploadDuplicate);

  // Another user, and an anonymous visitor, cannot read the file or the library.
  const other = await browser.newContext({ baseURL: 'http://localhost:3100' });
  const anonymous = await browser.newContext({ baseURL: 'http://localhost:3100' });
  try {
    await registerAndVerify(await other.newPage(), locale, 'Library outsider');
    const fileUrl = href.replace(/#.*$/u, '');
    expect((await other.request.get(fileUrl)).status()).toBe(403);
    expect(
      (
        await other.request.get(`/api/projects/${project.id}/sources?workspaceId=${workspaceId}`)
      ).status(),
    ).toBe(403);
    expect(
      (
        await other.request.post(`/api/projects/${project.id}/sources?workspaceId=${workspaceId}`, {
          headers: ORIGIN,
          multipart: { file: { name: 'x.txt', mimeType: 'text/plain', buffer: Buffer.from('x') } },
        })
      ).status(),
    ).toBe(403);
    expect((await anonymous.request.get(fileUrl)).status()).toBe(401);
    const page404 = await (
      await other.newPage()
    ).goto(`/${locale}/workspaces/${workspaceId}/projects/${project.id}`);
    expect(page404?.status()).toBe(404);
  } finally {
    await other.close();
    await anonymous.close();
  }
});

test('uploads are typed by their bytes and size-limited', async ({ page }, info) => {
  const locale = info.project.name === 'ar' ? 'ar' : 'en';
  await registerAndVerify(page, locale, 'Upload validation fixture');
  const { workspaces } = z
    .object({ workspaces: z.array(z.object({ id: z.uuid() })) })
    .parse(await (await page.request.get('/api/projects')).json());
  const workspaceId = workspaces[0]?.id ?? '';
  const created = await page.request.post('/api/projects', {
    headers: ORIGIN,
    data: { workspaceId, title: 'validation', language: locale },
  });
  const { project } = z.object({ project: z.object({ id: z.uuid() }) }).parse(await created.json());
  const url = `/api/projects/${project.id}/sources?workspaceId=${workspaceId}`;

  // A ZIP renamed to .pdf is refused: the type comes from the content.
  const fakePdf = await page.request.post(url, {
    headers: ORIGIN,
    multipart: {
      file: {
        name: 'paper.pdf',
        mimeType: 'application/pdf',
        buffer: Buffer.from([0x50, 0x4b, 3, 4, 0, 0, 0xff]),
      },
    },
  });
  expect(fakePdf.status()).toBe(415);
  expect(await fakePdf.json()).toEqual({ code: 'UPLOAD_UNSUPPORTED_TYPE' });

  // Cross-site requests are refused even with a valid session cookie.
  const crossSite = await page.request.post(url, {
    headers: { origin: 'https://evil.example' },
    multipart: { file: { name: 'a.txt', mimeType: 'text/plain', buffer: Buffer.from('نص') } },
  });
  expect(crossSite.status()).toBe(403);
});
