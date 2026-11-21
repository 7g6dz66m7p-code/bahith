import { expect, test } from '@playwright/test';
import { z } from 'zod';

import { registerAndVerify, resetRateLimits } from './helpers';

test.beforeEach(async () => {
  await resetRateLimits();
});

test('session identity and project scope protect every research HTTP endpoint', async ({
  page,
  browser,
}, info) => {
  const locale = info.project.name === 'ar' ? 'ar' : 'en';
  await registerAndVerify(page, locale, 'API owner fixture');
  const inventory = z
    .object({ workspaces: z.array(z.object({ id: z.uuid() })) })
    .parse(await (await page.request.get('/api/projects')).json());
  const workspaceId = inventory.workspaces[0]?.id;
  if (workspaceId === undefined) throw new Error('Expected the actual personal workspace');
  const headers = { origin: 'http://localhost:3100' };
  const created = await page.request.post('/api/projects', {
    headers,
    data: { workspaceId, title: 'API isolation fixture', language: locale },
  });
  expect(created.status()).toBe(201);
  const { project } = z.object({ project: z.object({ id: z.uuid() }) }).parse(await created.json());
  const other = await browser.newContext({ baseURL: 'http://localhost:3100' });
  const anonymous = await browser.newContext({ baseURL: 'http://localhost:3100' });
  try {
    const otherPage = await other.newPage();
    await registerAndVerify(otherPage, locale, 'API outsider fixture');
    expect(
      (
        await other.request.post('/api/projects', {
          headers,
          data: { workspaceId, title: 'forbidden creation' },
        })
      ).status(),
    ).toBe(403);
    expect(await (await other.request.get('/api/projects')).json()).toMatchObject({ projects: [] });
    const retrieval = { workspaceId, projectId: project.id, query: 'software fixture' };
    expect(
      (await other.request.post('/api/sanad/retrieve', { headers, data: retrieval })).status(),
    ).toBe(403);
    const own = await page.request.post('/api/sanad/retrieve', { headers, data: retrieval });
    expect(own.status()).toBe(200);
    expect(await own.json()).toMatchObject({ mode: 'lexical', results: [] });
    expect(
      (
        await page.request.post('/api/projects', {
          headers,
          data: { workspaceId, title: 'forged identity', userId: crypto.randomUUID() },
        })
      ).status(),
    ).toBe(400);
    expect(
      (
        await page.request.post('/api/sanad/retrieve', {
          headers,
          data: { ...retrieval, userId: crypto.randomUUID() },
        })
      ).status(),
    ).toBe(400);
    expect((await anonymous.request.get('/api/projects')).status()).toBe(401);
    expect(
      (
        await anonymous.request.post('/api/projects', {
          headers,
          data: { workspaceId, title: 'anonymous creation' },
        })
      ).status(),
    ).toBe(401);
    expect(
      (await anonymous.request.post('/api/sanad/retrieve', { headers, data: retrieval })).status(),
    ).toBe(401);
    expect(
      (
        await page.request.post('/api/projects', {
          headers: { origin: 'https://evil.example.test' },
          data: { workspaceId, title: 'cross-origin creation' },
        })
      ).status(),
    ).toBe(403);
  } finally {
    await other.close();
    await anonymous.close();
  }
});

test('reference, verification and assistant endpoints refuse outsiders, anonymous and cross-origin calls', async ({
  page,
  browser,
}, info) => {
  const locale = info.project.name === 'ar' ? 'ar' : 'en';
  await registerAndVerify(page, locale, 'Endpoint owner fixture');
  const inventory = z
    .object({ workspaces: z.array(z.object({ id: z.uuid() })) })
    .parse(await (await page.request.get('/api/projects')).json());
  const workspaceId = inventory.workspaces[0]?.id ?? '';
  const headers = { origin: 'http://localhost:3100' };
  const created = await page.request.post('/api/projects', {
    headers,
    data: { workspaceId, title: 'Endpoint isolation fixture', language: locale },
  });
  const { project } = z.object({ project: z.object({ id: z.uuid() }) }).parse(await created.json());
  const base = `/api/projects/${project.id}`;
  const query = `workspaceId=${workspaceId}`;
  const bib = { name: 'r.bib', mimeType: 'text/plain', buffer: Buffer.from('@book{a, title={T}}') };
  type Ctx = typeof page.request;
  const calls: [string, (r: Ctx, h: Record<string, string>) => ReturnType<Ctx['get']>][] = [
    ['list references', (r) => r.get(`${base}/references?${query}`)],
    [
      'add by DOI',
      (r, h) =>
        r.post(`${base}/references?${query}`, { headers: h, data: { doi: '10.1038/nature14539' } }),
    ],
    [
      'import',
      (r, h) =>
        r.post(`${base}/references/import?${query}`, { headers: h, multipart: { file: bib } }),
    ],
    ['export', (r) => r.get(`${base}/references/export?${query}&format=ris`)],
    [
      'verify',
      (r, h) =>
        r.post(`${base}/sources/${crypto.randomUUID()}/verify?${query}`, { headers: h, data: {} }),
    ],
    ['read consent', (r) => r.get(`${base}/ai-consent?${query}`)],
    [
      'grant consent',
      (r, h) => r.put(`${base}/ai-consent?${query}`, { headers: h, data: { enabled: true } }),
    ],
    [
      'ask',
      (r, h) =>
        r.post(`${base}/assistant?${query}`, {
          headers: h,
          data: { question: 'q', language: locale },
        }),
    ],
  ];
  const other = await browser.newContext({ baseURL: 'http://localhost:3100' });
  const anonymous = await browser.newContext({ baseURL: 'http://localhost:3100' });
  try {
    await registerAndVerify(await other.newPage(), locale, 'Endpoint outsider fixture');
    for (const [name, call] of calls) {
      expect([403, 404], `${name} (outsider)`).toContain(
        (await call(other.request, headers)).status(),
      );
      expect((await call(anonymous.request, headers)).status(), `${name} (anonymous)`).toBe(401);
    }
    // State-changing calls from another origin are refused even for the owner.
    for (const [name, call] of calls.filter(
      ([n]) => !['list references', 'export', 'read consent'].includes(n),
    )) {
      expect(
        (await call(page.request, { origin: 'https://evil.example.test' })).status(),
        `${name} (cross-origin)`,
      ).toBe(403);
    }
    // Nothing the outsider did reached the owner's project.
    const own = await page.request.get(`${base}/ai-consent?${query}`);
    expect(await own.json()).toMatchObject({ enabled: false });
    expect(await (await page.request.get(`${base}/references?${query}`)).json()).toEqual({
      references: [],
    });
  } finally {
    await other.close();
    await anonymous.close();
  }
});
