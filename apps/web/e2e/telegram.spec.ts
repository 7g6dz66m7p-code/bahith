import { createHash, createHmac } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import { expect, test } from '@playwright/test';

import { registerAndVerify, resetRateLimits } from './helpers';
import { TELEGRAM_TEST_TOKEN_FILE } from './sms';

test.beforeEach(async () => {
  await resetRateLimits();
});

/** Signs Login Widget fields the way Telegram does (test bot token of this run). */
async function signedWidget(id: string, authDate = Math.floor(Date.now() / 1000)) {
  const token = await readFile(TELEGRAM_TEST_TOKEN_FILE, 'utf8');
  const fields: Record<string, string> = { id, first_name: 'Fixture', auth_date: String(authDate) };
  const check = Object.keys(fields)
    .sort()
    .map((key) => `${key}=${fields[key] ?? ''}`)
    .join('\n');
  const secret = createHash('sha256').update(token).digest();
  return { ...fields, hash: createHmac('sha256', secret).update(check).digest('hex') };
}

test('a signed-in user links Telegram only with a valid Telegram signature', async ({
  page,
  browser,
}, info) => {
  const locale = info.project.name.startsWith('ar') ? 'ar' : 'en';
  await registerAndVerify(page, locale, 'Telegram fixture');
  const headers = { origin: 'http://localhost:3100' };
  const telegramId = String(1_000_000 + Math.floor(Math.random() * 1_000_000_000));
  const api = '/api/account/telegram';

  expect(await (await page.request.get(api)).json()).toEqual({
    linked: false,
    telegramUserId: null,
  });
  const forged = { ...(await signedWidget(telegramId)), hash: '0'.repeat(64) };
  expect((await page.request.post(api, { headers, data: { widget: forged } })).status()).toBe(401);
  const stale = await signedWidget(telegramId, Math.floor(Date.now() / 1000) - 7200);
  expect((await page.request.post(api, { headers, data: { widget: stale } })).status()).toBe(401);
  const valid = await signedWidget(telegramId);
  expect(
    (
      await page.request.post(api, {
        headers: { origin: 'https://evil.example.test' },
        data: { widget: valid },
      })
    ).status(),
  ).toBe(403);
  const linked = await page.request.post(api, { headers, data: { widget: valid } });
  expect(linked.status()).toBe(200);
  expect(await (await page.request.get(api)).json()).toEqual({
    linked: true,
    telegramUserId: telegramId,
  });

  const other = await browser.newContext({ baseURL: 'http://localhost:3100' });
  try {
    await registerAndVerify(await other.newPage(), locale, 'Telegram outsider');
    // Another account cannot take over an already linked Telegram id…
    expect(
      (
        await other.request.post(api, { headers, data: { widget: await signedWidget(telegramId) } })
      ).status(),
    ).toBe(409);
    // …and sees only its own (empty) link.
    expect(await (await other.request.get(api)).json()).toEqual({
      linked: false,
      telegramUserId: null,
    });
    const anonymous = await browser.newContext({ baseURL: 'http://localhost:3100' });
    expect((await anonymous.request.get(api)).status()).toBe(401);
    await anonymous.close();
  } finally {
    await other.close();
  }
  expect((await page.request.delete(api, { headers })).status()).toBe(200);
  expect(await (await page.request.get(api)).json()).toEqual({
    linked: false,
    telegramUserId: null,
  });
});
