import { expect, test } from '@playwright/test';
import { z } from 'zod';

import ar from '../messages/ar.json' with { type: 'json' };
import en from '../messages/en.json' with { type: 'json' };

import { registerAndVerify, resetRateLimits } from './helpers';

const ORIGIN = { origin: 'http://localhost:3100' };

test.beforeEach(async () => {
  await resetRateLimits();
});

test('the assistant asks for consent first and says clearly when no model is configured', async ({
  page,
  browser,
}, info) => {
  const locale = info.project.name === 'ar' ? 'ar' : 'en';
  const m = (locale === 'ar' ? ar : en).Assistant;
  await registerAndVerify(page, locale, 'Assistant fixture');
  const { workspaces } = z
    .object({ workspaces: z.array(z.object({ id: z.uuid() })) })
    .parse(await (await page.request.get('/api/projects')).json());
  const workspaceId = workspaces[0]?.id ?? '';
  const created = await page.request.post('/api/projects', {
    headers: ORIGIN,
    data: { workspaceId, title: 'مشروع المساعد', language: locale },
  });
  const { project } = z.object({ project: z.object({ id: z.uuid() }) }).parse(await created.json());
  const api = `/api/projects/${project.id}`;
  const query = `workspaceId=${workspaceId}`;

  // Without consent the API refuses before anything else happens.
  const refused = await page.request.post(`${api}/assistant?${query}`, {
    headers: ORIGIN,
    data: { question: 'ما نتائج الدراسة؟', language: locale },
  });
  expect(refused.status()).toBe(409);
  expect(await refused.json()).toEqual({ code: 'AI_CONSENT_REQUIRED' });

  await page.goto(`/${locale}/workspaces/${workspaceId}/projects/${project.id}`);
  const panel = page.locator('section[aria-labelledby="assistant-title"]');
  await expect(panel.getByRole('heading', { name: m.consentTitle })).toBeVisible();
  // It names the destination (here: nothing configured) before asking for consent.
  await expect(panel).toContainText(m.modelNotConfigured);
  await expect(panel.getByLabel(m.questionLabel)).toHaveCount(0);

  await panel.getByRole('button', { name: m.grantConsent }).click();
  await expect(panel.getByTestId('consent-state')).toBeVisible();
  await panel.getByLabel(m.questionLabel).fill('ما نتائج الدراسة؟');
  await panel.getByRole('button', { name: m.ask, exact: true }).click();
  await expect(panel.getByRole('alert')).toHaveText(m.errorNotConfigured);
  await expect(panel.getByTestId('assistant-answer')).toHaveCount(0);

  // Checking a claim goes through the same gates and says the same thing.
  const claimCheck = panel.getByTestId('claim-check');
  await claimCheck
    .getByLabel((locale === 'ar' ? ar : en).ClaimCheck.claimLabel)
    .fill('التعلم المدمج يرفع التحصيل');
  await claimCheck
    .getByRole('button', { name: (locale === 'ar' ? ar : en).ClaimCheck.check, exact: true })
    .click();
  await expect(claimCheck.getByRole('alert')).toHaveText(m.errorNotConfigured);

  // Consent survives a reload and can be withdrawn.
  await page.reload();
  await expect(panel.getByTestId('consent-state')).toBeVisible();
  await panel.getByRole('button', { name: m.withdrawConsent }).click();
  await expect(panel.getByRole('heading', { name: m.consentTitle })).toBeVisible();

  // Another user can neither read nor change this project's consent.
  const outsider = await browser.newContext({ baseURL: 'http://localhost:3100' });
  const other = await outsider.newPage();
  await registerAndVerify(other, locale, 'Assistant outsider');
  expect([403, 404]).toContain(
    (
      await other.request.put(`${api}/ai-consent?${query}`, {
        headers: ORIGIN,
        data: { enabled: true },
      })
    ).status(),
  );
  await outsider.close();
});
