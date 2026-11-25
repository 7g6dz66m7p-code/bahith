import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import type { APIRequestContext } from '@playwright/test';
import { z } from 'zod';

import ar from '../messages/ar.json' with { type: 'json' };
import en from '../messages/en.json' with { type: 'json' };

import { addWorkspaceMember, registerAndVerify, resetRateLimits } from './helpers';

/**
 * In-app notifications: a supervisor's review note reaches the owner (and only the
 * owner), not a viewer of the same workspace nor an outsider; a decision on a suggestion
 * reaches its author. Anonymous requests are refused; nobody can mark someone else's
 * notifications read. All text is synthetic test content.
 */
const BASE = 'http://localhost:3100';
const ORIGIN = { origin: BASE };
const SENTENCE = 'تعتمد الدراسة على المنهج الوصفي في تحليل البيانات';
const PROJECT_TITLE = 'مشروع الإشعارات';

const paragraphDoc = (text: string) => ({
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
});
const anchorIn = (quote: string, versionNumber: number) => {
  const offset = SENTENCE.indexOf(quote);
  return { versionNumber, from: 1 + offset, to: 1 + offset + quote.length, quote };
};

const listSchema = z.object({
  unreadCount: z.number(),
  notifications: z.array(
    z.object({
      id: z.uuid(),
      kind: z.string(),
      workspaceId: z.uuid(),
      entityId: z.uuid(),
      readAt: z.string().nullable(),
    }),
  ),
});

async function userIdOf(request: APIRequestContext): Promise<string> {
  return z
    .object({ user: z.object({ id: z.uuid() }) })
    .parse(await (await request.get('/api/auth/get-session')).json()).user.id;
}

async function notificationsOf(request: APIRequestContext) {
  const response = await request.get('/api/notifications');
  expect(response.status()).toBe(200);
  return listSchema.parse(await response.json());
}

test.beforeEach(async () => {
  await resetRateLimits();
});

test('a review note notifies the owner only; reading and marking stay private', async ({
  page,
  browser,
}, info) => {
  test.setTimeout(180_000);
  const locale = info.project.name.startsWith('ar') ? 'ar' : 'en';
  const n = (locale === 'ar' ? ar : en).Notifications;

  // The owner's project and draft.
  await registerAndVerify(page, locale, 'Notify owner');
  const { workspaces } = z
    .object({ workspaces: z.array(z.object({ id: z.uuid() })) })
    .parse(await (await page.request.get('/api/projects')).json());
  const workspaceId = workspaces[0]?.id ?? '';
  const { project } = z.object({ project: z.object({ id: z.uuid() }) }).parse(
    await (
      await page.request.post('/api/projects', {
        headers: ORIGIN,
        data: { workspaceId, title: PROJECT_TITLE, language: locale },
      })
    ).json(),
  );
  const q = `?workspaceId=${workspaceId}`;
  const { document } = z.object({ document: z.object({ id: z.uuid() }) }).parse(
    await (
      await page.request.post(`/api/projects/${project.id}/documents${q}`, {
        headers: ORIGIN,
        data: { title: 'فصل' },
      })
    ).json(),
  );
  const docBase = `/api/projects/${project.id}/documents/${document.id}`;
  expect(
    (
      await page.request.put(`${docBase}${q}`, {
        headers: ORIGIN,
        data: { content: paragraphDoc(SENTENCE), baseVersion: 1, kind: 'manual' },
      })
    ).status(),
  ).toBe(200);
  expect(await notificationsOf(page.request)).toEqual({ unreadCount: 0, notifications: [] });

  const supervisorContext = await browser.newContext({ baseURL: BASE });
  const viewerContext = await browser.newContext({ baseURL: BASE });
  const outsiderContext = await browser.newContext({ baseURL: BASE });
  const anonymous = await browser.newContext({ baseURL: BASE });
  try {
    await registerAndVerify(await supervisorContext.newPage(), locale, 'Notify supervisor');
    await addWorkspaceMember(workspaceId, await userIdOf(supervisorContext.request), 'supervisor');
    const viewer = await viewerContext.newPage();
    await registerAndVerify(viewer, locale, 'Notify viewer');
    await addWorkspaceMember(workspaceId, await userIdOf(viewerContext.request), 'viewer');
    await registerAndVerify(await outsiderContext.newPage(), locale, 'Notify outsider');

    // The supervisor comments and suggests.
    expect(
      (
        await supervisorContext.request.post(`${docBase}/comments${q}`, {
          headers: ORIGIN,
          data: { kind: 'comment', anchor: anchorIn('المنهج الوصفي', 2), body: 'لماذا؟' },
        })
      ).status(),
    ).toBe(201);
    const suggestion = await supervisorContext.request.post(`${docBase}/comments${q}`, {
      headers: ORIGIN,
      data: {
        kind: 'suggestion',
        anchor: anchorIn('تحليل البيانات', 2),
        replacement: 'تحليل بيانات الاستبانة',
      },
    });
    expect(suggestion.status()).toBe(201);
    const suggestionId = z
      .object({ comment: z.object({ id: z.uuid() }) })
      .parse(await suggestion.json()).comment.id;

    // The owner is told twice; the author, the viewer and the outsider are not.
    const owners = await notificationsOf(page.request);
    expect(owners.unreadCount).toBe(2);
    expect(owners.notifications.map((entry) => [entry.kind, entry.entityId])).toEqual([
      ['review_comment', document.id],
      ['review_comment', document.id],
    ]);
    for (const request of [
      supervisorContext.request,
      viewerContext.request,
      outsiderContext.request,
    ]) {
      expect(await notificationsOf(request)).toEqual({ unreadCount: 0, notifications: [] });
    }

    // Nobody else can mark the owner's notifications read, and cross-site posts fail.
    const ownerIds = owners.notifications.map((entry) => entry.id);
    for (const request of [viewerContext.request, outsiderContext.request]) {
      const response = await request.post('/api/notifications/read', {
        headers: ORIGIN,
        data: { ids: ownerIds },
      });
      expect(response.status()).toBe(200);
      expect(await response.json()).toEqual({ updated: 0 });
    }
    expect(
      (
        await page.request.post('/api/notifications/read', {
          headers: { origin: 'https://attacker.example.test' },
          data: { all: true },
        })
      ).status(),
    ).toBe(403);
    expect(
      (
        await page.request.post('/api/notifications/read', {
          headers: ORIGIN,
          data: { ids: ['not-a-uuid'] },
        })
      ).status(),
    ).toBe(400);
    expect((await notificationsOf(page.request)).unreadCount).toBe(2);

    // Anonymous visitors get nothing.
    expect((await anonymous.request.get('/api/notifications')).status()).toBe(401);
    expect(
      (
        await anonymous.request.post('/api/notifications/read', {
          headers: ORIGIN,
          data: { all: true },
        })
      ).status(),
    ).toBe(401);

    // The owner sees the count in the dashboard header and opens the notifications page.
    await page.goto(`/${locale}/dashboard`);
    const bell = page.getByTestId('notification-bell');
    await expect(bell).toHaveAttribute('aria-label', n.bellUnread.replace('{count}', '2'));
    await expect(page.getByTestId('notification-count')).toHaveText('2');
    await bell.click();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(n.title);
    const items = page.getByTestId('notification');
    await expect(items).toHaveCount(2);
    await expect(items.first()).toContainText(
      n.kind.review_comment.replace('<name>{project}</name>', PROJECT_TITLE),
    );
    await expect(items.first().getByRole('link', { name: n.openDraft })).toHaveAttribute(
      'href',
      `/${locale}/workspaces/${workspaceId}/projects/${project.id}/documents/${document.id}`,
    );
    const report = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();
    expect(
      report.violations.filter(
        (violation) => violation.impact === 'critical' || violation.impact === 'serious',
      ),
    ).toEqual([]);
    await page.getByRole('button', { name: n.markAllRead }).click();
    await expect(page.getByRole('status')).toHaveText(n.allRead);
    await expect(page.locator('[data-testid="notification"][data-read="false"]')).toHaveCount(0);
    expect((await notificationsOf(page.request)).unreadCount).toBe(0);
    await page.goto(`/${locale}/dashboard`);
    await expect(page.getByTestId('notification-bell')).toHaveAttribute('aria-label', n.bell);
    await expect(page.getByTestId('notification-count')).toHaveCount(0);

    // Declining the suggestion tells its author, who sees it on the project page header.
    expect(
      (
        await page.request.patch(`${docBase}/comments/${suggestionId}${q}`, {
          headers: ORIGIN,
          data: { action: 'reject' },
        })
      ).status(),
    ).toBe(200);
    const authors = await notificationsOf(supervisorContext.request);
    expect(authors.notifications.map((entry) => [entry.kind, entry.workspaceId])).toEqual([
      ['suggestion_decided', workspaceId],
    ]);
    expect((await notificationsOf(page.request)).unreadCount).toBe(0);
    expect((await notificationsOf(viewerContext.request)).unreadCount).toBe(0);

    // The viewer's page is empty.
    await viewer.goto(`/${locale}/notifications`);
    await expect(viewer.getByText(n.empty)).toBeVisible();
    await viewer.goto(`/${locale}/workspaces/${workspaceId}/projects/${project.id}`);
    await expect(viewer.getByTestId('notification-bell')).toHaveAttribute('aria-label', n.bell);
  } finally {
    await supervisorContext.close();
    await viewerContext.close();
    await outsiderContext.close();
    await anonymous.close();
  }
});
