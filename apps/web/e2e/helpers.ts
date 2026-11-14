import { createHmac } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { createDatabase } from '@bahith/db';
import { z } from 'zod';

const BASE = 'http://localhost:3100';

async function mailUrl() {
  return z
    .object({ mailUrl: z.url() })
    .parse(
      JSON.parse(
        await readFile(path.resolve(import.meta.dirname, '../.next/e2e-runtime.json'), 'utf8'),
      ),
    ).mailUrl;
}

/** Test fixture isolation only. Production policy remains active and has a separate 429 test. */
export async function resetRateLimits() {
  const metadata = z
    .object({ authUrl: z.url() })
    .parse(
      JSON.parse(
        await readFile(path.resolve(import.meta.dirname, '../.next/e2e-runtime.json'), 'utf8'),
      ),
    );
  const database = createDatabase({ connectionString: metadata.authUrl });
  try {
    await database.pool.query('DELETE FROM auth_rate_limits');
  } finally {
    await database.close();
  }
}

/** Reads real local SMTP deliveries from an isolated Mailpit container, never a public inbox. */
export async function readVerificationUrl(email: string): Promise<string> {
  const base = await mailUrl();
  let result: string | undefined;
  await expect(async () => {
    const messages = z
      .object({
        messages: z.array(
          z.object({ ID: z.string(), To: z.array(z.object({ Address: z.string() })) }),
        ),
      })
      .parse(await (await fetch(`${base}/api/v1/messages`)).json());
    const match = messages.messages.find((message) =>
      message.To.some((to) => to.Address === email),
    );
    expect(match).toBeDefined();
    if (match === undefined) return;
    const message = z
      .object({ Text: z.string() })
      .parse(await (await fetch(`${base}/api/v1/message/${match.ID}`)).json());
    result = message.Text.match(/https?:\/\/\S+/u)?.[0];
    expect(result).toBeDefined();
  }).toPass({ timeout: 15_000 });
  if (result === undefined) throw new Error('Expected a local verification email');
  return result;
}

/** Real HTTP signup + SMTP verification + cookie session, for tests unrelated to form entry. */
export async function registerAndVerify(page: Page, locale: 'ar' | 'en', name = 'باحث الاختبار') {
  const identity = {
    name,
    email: `browser-${crypto.randomUUID()}@example.test`,
    password: `BrowserFixture-${crypto.randomUUID()}`,
  };
  const signup = await page.request.post('/api/auth/sign-up/email', {
    headers: { origin: BASE },
    data: { ...identity, locale, callbackURL: `${BASE}/${locale}/dashboard` },
  });
  expect(signup.status()).toBe(200);
  const verification = await page.request.get(await readVerificationUrl(identity.email));
  expect(verification.ok()).toBe(true);
  const signin = await page.request.post('/api/auth/sign-in/email', {
    headers: { origin: BASE },
    data: { email: identity.email, password: identity.password },
  });
  expect(signin.status()).toBe(200);
  await page.goto(`/${locale}/dashboard`);
  return identity;
}

/** RFC6238 test fixture helper; production TOTP stays in Better Auth. */
export function totpCode(secret: string): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const char of secret.toUpperCase().replace(/=+$/u, '')) {
    const index = alphabet.indexOf(char);
    if (index < 0) throw new Error('Invalid fixture TOTP secret');
    bits += index.toString(2).padStart(5, '0');
  }
  const bytes = Buffer.from((bits.match(/.{8}/gu) ?? []).map((byte) => Number.parseInt(byte, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30_000)));
  const digest = createHmac('sha1', bytes).update(counter).digest();
  return ((digest.readUInt32BE((digest.at(-1) ?? 0) & 15) & 0x7fffffff) % 1_000_000)
    .toString()
    .padStart(6, '0');
}
