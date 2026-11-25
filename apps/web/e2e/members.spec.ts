import { expect, test } from '@playwright/test';
import { z } from 'zod';

import ar from '../messages/ar.json' with { type: 'json' };
import en from '../messages/en.json' with { type: 'json' };

import { readMailLink, registerAndVerify, resetRateLimits } from './helpers';

const BASE = 'http://localhost:3100';

test.beforeEach(async () => {
  await resetRateLimits();
});

test('an owner invites by email, the invitee joins, gets a new role and is removed', async ({
  page,
  browser,
}, info) => {
  const locale = info.project.name.startsWith('ar') ? 'ar' : 'en';
  test.setTimeout(120_000);
  const m = (locale === 'ar' ? ar : en).Members;
  const inv = (locale === 'ar' ? ar : en).Invitation;
  await registerAndVerify(page, locale, 'Members owner');
  const workspaces = async (request: typeof page.request) =>
    z
      .object({ workspaces: z.array(z.object({ id: z.uuid() })) })
      .parse(await (await request.get('/api/projects')).json())
      .workspaces.map((w) => w.id);
  const [workspaceId] = await workspaces(page.request);

  const inviteeContext = await browser.newContext({ baseURL: BASE });
  const outsiderContext = await browser.newContext({ baseURL: BASE });
  try {
    const invitee = await inviteeContext.newPage();
    const identity = await registerAndVerify(invitee, locale, 'Members invitee');

    // The owner reaches the members page from the dashboard and invites by email.
    await page.goto(`/${locale}/dashboard`);
    await page.getByRole('link', { name: m.manage }).click();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(m.title);
    await page.getByLabel(m.email).fill(identity.email.toUpperCase());
    await page.getByLabel(m.role, { exact: true }).selectOption('supervisor');
    await page.getByRole('button', { name: m.invite }).click();
    await expect(page.getByRole('status')).toHaveText(m.invited);
    await expect(page.getByTestId('invitation')).toHaveCount(1);
    const shown = await page.getByTestId('invitation-link').inputValue();
    expect(shown).toContain('/invitations/accept#');

    // The real email (local Mailpit) carries the same link; the token is in the fragment.
    const link = await readMailLink(identity.email, '/invitations/accept#');
    expect(link).toBe(shown);
    await invitee.goto(link.replace(BASE, ''));
    await invitee.getByRole('button', { name: inv.accept }).click();
    await expect(invitee.getByRole('status')).toHaveText(
      inv.joined.replace('{role}', m.supervisor),
    );
    expect(await workspaces(invitee.request)).toContain(workspaceId);
    // The used link cannot be used by someone else.
    const outsider = await outsiderContext.newPage();
    await registerAndVerify(outsider, locale, 'Members outsider');
    const reuse = await outsider.request.post('/api/invitations/accept', {
      headers: { origin: BASE },
      data: { token: link.split('#')[1] },
    });
    expect(reuse.status()).toBe(403);

    // The owner sees the member, changes the role, then removes them.
    await page.reload();
    await expect(page.getByTestId('invitation')).toHaveCount(0);
    const row = page.getByTestId('member').filter({ hasText: identity.email.toLowerCase() });
    await row.getByRole('combobox').selectOption('editor');
    await expect(row.getByRole('combobox')).toHaveValue('editor');
    await row.getByRole('button', { name: m.remove }).click();
    await expect(page.getByTestId('member')).toHaveCount(1);
    expect(await workspaces(invitee.request)).not.toContain(workspaceId);

    // Outsiders and anonymous visitors get nothing; other origins cannot change anything.
    const api = `/api/workspaces/${workspaceId ?? ''}`;
    expect([403, 404]).toContain((await outsider.request.get(`${api}/members`)).status());
    expect(
      (
        await outsider.request.post(`${api}/members`, {
          headers: { origin: BASE },
          data: { email: 'a@example.test', role: 'editor', locale },
        })
      ).status(),
    ).toBe(403);
    expect(
      (await (await browser.newContext({ baseURL: BASE })).request.get(`${api}/members`)).status(),
    ).toBe(401);
    expect(
      (
        await page.request.post(`${api}/members`, {
          headers: { origin: 'https://evil.example.test' },
          data: { email: 'a@example.test', role: 'editor', locale },
        })
      ).status(),
    ).toBe(403);
  } finally {
    await inviteeContext.close();
    await outsiderContext.close();
  }
});
