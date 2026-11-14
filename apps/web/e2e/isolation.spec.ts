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
