import { expect, test } from '@playwright/test';
import { z } from 'zod';

import ar from '../messages/ar.json' with { type: 'json' };
import en from '../messages/en.json' with { type: 'json' };

import { registerAndVerify, resetRateLimits, totpCode } from './helpers';

const BASE = 'http://localhost:3100';
const ORIGIN = { origin: BASE };

test.beforeEach(async () => {
  await resetRateLimits();
});

test('platform admin needs 2FA, sees aggregate stats and sets plan limits; others see nothing', async ({
  page,
  browser,
}, info) => {
  test.setTimeout(120_000);
  const locale = info.project.name === 'ar' ? 'ar' : 'en';
  const t = (locale === 'ar' ? ar : en).Admin;
  const usage = (locale === 'ar' ? ar : en).Usage;
  const identity = await registerAndVerify(
    page,
    locale,
    'Platform admin',
    `e2e-admin-${locale}@example.test`,
  );

  // Listed, but without two-factor authentication: not an administrator yet.
  expect((await page.request.get('/api/admin/stats')).status()).toBe(404);
  const enabled = z.object({ totpURI: z.string() }).parse(
    await (
      await page.request.post('/api/auth/two-factor/enable', {
        headers: ORIGIN,
        data: { password: identity.password },
      })
    ).json(),
  );
  const secret = new URL(enabled.totpURI).searchParams.get('secret') ?? '';
  const verified = await page.request.post('/api/auth/two-factor/verify-totp', {
    headers: ORIGIN,
    data: { code: totpCode(secret) },
  });
  expect(verified.ok()).toBe(true);

  const stats = await page.request.get('/api/admin/stats');
  expect(stats.status()).toBe(200);
  const body = JSON.stringify(await stats.json());
  expect(body).not.toContain('@');

  await page.goto(`/${locale}/admin`);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(t.title);
  // Consumption per model is shown (empty in e2e: no AI provider is configured there).
  await expect(page.getByRole('heading', { name: t.usageTitle })).toBeVisible();
  await expect(page.getByText(t.usageNone)).toBeVisible();
  await expect(page.getByTestId('stat-users')).toBeVisible();
  await page.getByLabel(t.limitFor.replace('{plan}', 'Free')).fill('5');
  await page.getByRole('button', { name: t.save }).first().click();
  await expect(page.getByRole('status')).toHaveText(t.saved);

  // A workspace on the free plan now shows the limit; upgrading is honest about payments.
  const { workspaces } = z
    .object({ workspaces: z.array(z.object({ id: z.uuid() })) })
    .parse(await (await page.request.get('/api/projects')).json());
  await page.goto(`/${locale}/workspaces/${workspaces[0]?.id ?? ''}/members`);
  await expect(page.getByTestId('usage')).toContainText(
    usage.used.replace('{used}', '0').replace('{limit}', '5'),
  );
  await page.getByRole('button', { name: usage.upgrade }).click();
  await expect(page.getByTestId('usage').getByRole('status')).toHaveText(usage.paymentsDisabled);

  // Anyone else: the admin area does not exist; the plan cannot be changed.
  const other = await browser.newContext({ baseURL: BASE });
  try {
    const user = await other.newPage();
    await registerAndVerify(user, locale, 'Not an admin');
    expect((await user.request.get('/api/admin/stats')).status()).toBe(404);
    expect(
      (
        await user.request.put('/api/admin/plans/free', {
          headers: ORIGIN,
          data: { aiRequestsPerMonth: 999 },
        })
      ).status(),
    ).toBe(404);
    expect((await user.goto(`/${locale}/admin`))?.status()).toBe(404);
    expect(
      (
        await (await browser.newContext({ baseURL: BASE })).request.get('/api/admin/stats')
      ).status(),
    ).toBe(401);
  } finally {
    await other.close();
  }
  // Cross-origin changes are refused even for the administrator.
  expect(
    (
      await page.request.put('/api/admin/plans/free', {
        headers: { origin: 'https://evil.example.test' },
        data: { aiRequestsPerMonth: 1 },
      })
    ).status(),
  ).toBe(403);
});
