import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { z } from 'zod';

import ar from '../messages/ar.json' with { type: 'json' };
import en from '../messages/en.json' with { type: 'json' };

import { registerAndVerify, resetRateLimits } from './helpers';

const ORIGIN = { origin: 'http://localhost:3100' };
/** Synthetic test text, not a real research source. */
const TEXT = 'تعتمد الدراسة على المنهج الوصفي التحليلي في تحليل البيانات الميدانية.';

/** Synthetic CSL-JSON in the shape Zotero exports ("CSL JSON"). */
const CSL_JSON = JSON.stringify([
  {
    id: '1/A',
    type: 'article-journal',
    title: 'أثر التعلم المدمج في التحصيل',
    author: [{ family: 'الأحمد', given: 'سارة' }],
    issued: { 'date-parts': [['2024']] },
  },
  { id: '1/B', type: 'book', title: 'Methods of Qualitative Inquiry', publisher: 'Example Press' },
  { id: '1/N', type: 'document', note: 'a standalone note without a title' },
]);

test.beforeEach(async () => {
  await resetRateLimits();
});

async function newProject(page: Page, locale: 'ar' | 'en') {
  const { workspaces } = z
    .object({ workspaces: z.array(z.object({ id: z.uuid() })) })
    .parse(await (await page.request.get('/api/projects')).json());
  const workspaceId = workspaces[0]?.id ?? '';
  const created = await page.request.post('/api/projects', {
    headers: ORIGIN,
    data: { workspaceId, title: 'مشروع التنظيم', language: locale },
  });
  const { project } = z.object({ project: z.object({ id: z.uuid() }) }).parse(await created.json());
  return { workspaceId, projectId: project.id };
}

test('collections, a highlight with a note, and a CSL-JSON import', async ({ page }, info) => {
  test.setTimeout(180_000);
  const locale = info.project.name === 'ar' ? 'ar' : 'en';
  const messages = locale === 'ar' ? ar : en;
  await registerAndVerify(page, locale, 'Organisation fixture');
  const { workspaceId, projectId } = await newProject(page, locale);
  const api = `/api/projects/${projectId}`;
  const query = `workspaceId=${workspaceId}`;

  // A text source through the real pipeline.
  const uploaded = await page.request.post(`${api}/sources?${query}`, {
    headers: ORIGIN,
    multipart: { file: { name: 'study.txt', mimeType: 'text/plain', buffer: Buffer.from(TEXT) } },
  });
  expect(uploaded.status()).toBeLessThan(300);
  await page.goto(`/${locale}/workspaces/${workspaceId}/projects/${projectId}`);
  await expect(page.getByTestId('file-status')).toHaveText(messages.Project.statusReady, {
    timeout: 120_000,
  });

  // CSL-JSON import through the references form.
  const refs = page.locator('section[aria-labelledby="references-title"]');
  await refs.getByLabel(messages.References.importLabel).setInputFiles({
    name: 'zotero.json',
    mimeType: 'application/json',
    buffer: Buffer.from(CSL_JSON),
  });
  await refs.getByRole('button', { name: messages.References.import, exact: true }).click();
  await expect(refs.getByRole('status')).toContainText(locale === 'ar' ? 'مرجعان' : '2 references');
  const refItems = refs
    .getByRole('list', { name: messages.References.title })
    .getByRole('listitem');
  await expect(refItems.filter({ hasText: 'أثر التعلم المدمج' })).toHaveAttribute(
    'data-verification',
    'unverified',
  );

  // Create a collection, add the uploaded source, filter by it.
  const m = messages.Collections;
  await page.reload();
  const toolbar = page.getByTestId('collections');
  await toolbar.getByLabel(m.nameLabel).fill('المنهجية');
  await toolbar.getByRole('button', { name: m.create }).click();
  await expect(toolbar.getByRole('status')).toHaveText(m.created);
  const library = page.getByRole('list', { name: messages.Project.libraryTitle });
  const entry = library.getByRole('listitem').filter({ hasText: 'study' }).first();
  await entry.getByRole('combobox').selectOption({ label: 'المنهجية' });
  await entry.getByRole('button', { name: m.add }).click();
  await expect(toolbar.getByRole('status')).toHaveText(m.added);
  await expect(entry).toContainText(m.memberOf);
  await toolbar.getByLabel(m.filterLabel).selectOption({ label: 'المنهجية (1)' });
  await expect(library.locator(':scope > li')).toHaveCount(1);

  // Highlight a selected span with a note from the evidence results.
  const h = messages.Highlights;
  await page.getByLabel(messages.Project.searchLabel).fill('المنهج الوصفي');
  await page.getByRole('button', { name: messages.Project.search, exact: true }).click();
  const evidence = page.getByTestId('evidence').first();
  await expect(evidence).toContainText('المنهج الوصفي');
  await evidence
    .locator('p')
    .first()
    .evaluate((element, word) => {
      const node = element.firstChild;
      const text = node?.textContent ?? '';
      const start = text.indexOf(word);
      const range = document.createRange();
      if (node === null) return;
      range.setStart(node, start);
      range.setEnd(node, start + word.length);
      const selection = document.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
    }, 'المنهج الوصفي');
  await evidence.getByRole('button', { name: h.openLabel }).click();
  await evidence.getByLabel(h.noteLabel).fill('مصطلح أساسي في الفصل الثالث');
  await evidence.getByRole('radio', { name: new RegExp('المنهج الوصفي') }).check();
  await evidence.getByRole('button', { name: h.save }).click();
  await expect(evidence.getByRole('status')).toHaveText(h.saved);

  const panel = page.locator('section[aria-labelledby="highlights-title"]');
  const item = panel.getByTestId('highlight');
  await expect(item).toHaveCount(1);
  await expect(item.locator('blockquote')).toHaveText('المنهج الوصفي');
  await expect(item.getByTestId('highlight-note')).toHaveText('مصطلح أساسي في الفصل الثالث');
  const stored = z
    .object({ highlights: z.array(z.object({ quote: z.string(), charStart: z.number() })) })
    .parse(await (await page.request.get(`${api}/highlights?${query}`)).json());
  expect(stored.highlights[0]?.quote).toBe('المنهج الوصفي');
  expect(stored.highlights[0]?.charStart).toBe(
    Array.from(TEXT.slice(0, TEXT.indexOf('المنهج'))).length,
  );

  // A misquoted highlight is refused by the server.
  const misquote = await page.request.post(`${api}/highlights?${query}`, {
    headers: ORIGIN,
    data: {
      chunkId: z
        .object({ highlights: z.array(z.object({ chunkId: z.uuid() })) })
        .parse(await (await page.request.get(`${api}/highlights?${query}`)).json()).highlights[0]
        ?.chunkId,
      charStart: 0,
      charEnd: 5,
      quote: 'abcde',
    },
  });
  expect(misquote.status()).toBe(422);

  // Delete it.
  await item.getByRole('button', { name: h.delete }).click();
  await expect(panel.getByTestId('highlight')).toHaveCount(0);
});

test('organisation and Zotero endpoints refuse outsiders, anonymous and cross-origin calls', async ({
  page,
  browser,
}, info) => {
  const locale = info.project.name === 'ar' ? 'ar' : 'en';
  await registerAndVerify(page, locale, 'Organisation owner');
  const { workspaceId, projectId } = await newProject(page, locale);
  const base = `/api/projects/${projectId}`;
  const query = `workspaceId=${workspaceId}`;
  const created = await page.request.post(`${base}/collections?${query}`, {
    headers: ORIGIN,
    data: { name: 'سري' },
  });
  expect(created.status()).toBe(201);
  const { collection } = z
    .object({ collection: z.object({ id: z.uuid() }) })
    .parse(await created.json());
  const someId = crypto.randomUUID();
  type Ctx = typeof page.request;
  const calls: [string, (r: Ctx, h: Record<string, string>) => ReturnType<Ctx['get']>][] = [
    ['list collections', (r) => r.get(`${base}/collections?${query}`)],
    [
      'create collection',
      (r, h) => r.post(`${base}/collections?${query}`, { headers: h, data: { name: 'x' } }),
    ],
    [
      'rename collection',
      (r, h) =>
        r.patch(`${base}/collections/${collection.id}?${query}`, {
          headers: h,
          data: { name: 'y' },
        }),
    ],
    [
      'delete collection',
      (r, h) => r.delete(`${base}/collections/${collection.id}?${query}`, { headers: h }),
    ],
    [
      'add to collection',
      (r, h) =>
        r.put(`${base}/collections/${collection.id}/sources/${someId}?${query}`, { headers: h }),
    ],
    [
      'remove from collection',
      (r, h) =>
        r.delete(`${base}/collections/${collection.id}/sources/${someId}?${query}`, {
          headers: h,
        }),
    ],
    ['list highlights', (r) => r.get(`${base}/highlights?${query}`)],
    [
      'add highlight',
      (r, h) =>
        r.post(`${base}/highlights?${query}`, {
          headers: h,
          data: { chunkId: someId, charStart: 0, charEnd: 1, quote: 'x' },
        }),
    ],
    [
      'edit note',
      (r, h) =>
        r.patch(`${base}/highlights/${someId}?${query}`, { headers: h, data: { note: 'x' } }),
    ],
    [
      'delete highlight',
      (r, h) => r.delete(`${base}/highlights/${someId}?${query}`, { headers: h }),
    ],
    [
      'zotero import',
      // Malformed credentials: nothing is ever sent to Zotero from tests.
      (r, h) =>
        r.post(`${base}/references/zotero?${query}`, {
          headers: h,
          data: { userId: 'not-digits', apiKey: 'x' },
        }),
    ],
  ];
  const other = await browser.newContext({ baseURL: 'http://localhost:3100' });
  const anonymous = await browser.newContext({ baseURL: 'http://localhost:3100' });
  try {
    await registerAndVerify(await other.newPage(), locale, 'Organisation outsider');
    for (const [name, call] of calls) {
      expect([403, 404], `${name} (outsider)`).toContain(
        (await call(other.request, ORIGIN)).status(),
      );
      expect((await call(anonymous.request, ORIGIN)).status(), `${name} (anonymous)`).toBe(401);
    }
    for (const [name, call] of calls.filter(([n]) => !n.startsWith('list'))) {
      expect(
        (await call(page.request, { origin: 'https://evil.example.test' })).status(),
        `${name} (cross-origin)`,
      ).toBe(403);
    }
    // The owner's malformed Zotero credentials are refused locally.
    const local = await page.request.post(`${base}/references/zotero?${query}`, {
      headers: ORIGIN,
      data: { userId: 'not-digits', apiKey: 'x' },
    });
    expect(local.status()).toBe(400);
    expect(await local.json()).toEqual({ code: 'ZOTERO_INVALID_CREDENTIALS' });
    // Nothing the outsider did reached the owner's project.
    const list = z
      .object({ collections: z.array(z.object({ name: z.string() })) })
      .parse(await (await page.request.get(`${base}/collections?${query}`)).json());
    expect(list.collections.map((c) => c.name)).toEqual(['سري']);
  } finally {
    await other.close();
    await anonymous.close();
  }
});
