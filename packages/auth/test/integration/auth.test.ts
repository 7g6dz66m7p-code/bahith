import { createHmac } from 'node:crypto';

import { createDatabase, schema } from '@bahith/db';
import { startTestDatabase } from '@bahith/db/testing';
import type { TestDatabase } from '@bahith/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

import type { BahithAuthService } from '../../src/auth';
import { createBahithAuth } from '../../src/auth';
import type { AuthMailMessage } from '../../src/mail';

const BASE = 'http://localhost:3000';

/** RFC 6238 fixture helper only; product TOTP verification belongs to Better Auth. */
function totp(secret: string): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const char of secret.replace(/=+$/u, '').toUpperCase()) {
    const value = alphabet.indexOf(char);
    if (value < 0) throw new Error('Invalid test TOTP URI');
    bits += value.toString(2).padStart(5, '0');
  }
  const bytes = Buffer.from((bits.match(/.{8}/gu) ?? []).map((byte) => Number.parseInt(byte, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30_000)));
  const digest = createHmac('sha1', bytes).update(counter).digest();
  const offset = (digest.at(-1) ?? 0) & 15;
  return ((digest.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).toString().padStart(6, '0');
}

describe('real Better Auth sessions, email verification, recovery and TOTP', () => {
  let database: TestDatabase;
  let service: BahithAuthService;
  const messages: AuthMailMessage[] = [];
  const jar = new Map<string, string>();
  const email = `auth-${crypto.randomUUID()}@example.test`;
  let password = `Fixture-${crypto.randomUUID()}`;
  let userId: string;

  async function request(path: string, body?: unknown, cookies = jar) {
    const response = await service.auth.handler(
      new Request(`${BASE}/api/auth${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: {
          origin: BASE,
          'content-type': 'application/json',
          cookie: [...cookies].map(([key, value]) => `${key}=${value}`).join('; '),
          'user-agent': 'BAHITH integration fixture',
          'x-forwarded-for': '127.0.0.1',
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );
    for (const line of response.headers.getSetCookie()) {
      const pair = line.split(';')[0] ?? '';
      const separator = pair.indexOf('=');
      if (separator < 0) continue;
      const name = pair.slice(0, separator);
      if (/max-age=0/iu.test(line)) cookies.delete(name);
      else cookies.set(name, pair.slice(separator + 1));
    }
    return response;
  }
  function lastMailUrl() {
    const message = messages.at(-1);
    const found = message?.text.match(/https?:\/\/\S+/u)?.[0];
    if (found === undefined) throw new Error('Expected fixture email delivery');
    return new URL(found);
  }

  beforeAll(async () => {
    database = await startTestDatabase();
    service = createBahithAuth(
      {
        databaseUrl: database.authUrl,
        baseUrl: BASE,
        secret: crypto.randomUUID() + crypto.randomUUID(),
      },
      {
        mailTransport: {
          send(message) {
            messages.push(message);
            return Promise.resolve();
          },
        },
      },
    );
  });
  afterAll(async () => {
    await service.close();
    await database.stop();
  });

  it('creates an unverified account, private workspace and owner membership atomically', async () => {
    const response = await request('/sign-up/email', {
      name: 'باحث الاختبار',
      email,
      password,
      callbackURL: `${BASE}/ar/dashboard`,
    });
    expect(response.status).toBe(200);
    const body = z
      .object({ user: z.object({ id: z.uuid(), emailVerified: z.boolean() }) })
      .parse(await response.json());
    expect(body.user.emailVerified).toBe(false);
    userId = body.user.id;
    const app = createDatabase({ connectionString: database.appUrl });
    try {
      const visible = await app.withUser(userId, (tx) =>
        tx.select({ role: schema.memberships.role }).from(schema.memberships),
      );
      expect(visible).toEqual([{ role: 'owner' }]);
    } finally {
      await app.close();
    }
    expect(messages.at(-1)?.to).toBe(email);
  });

  it('denies password sign-in before email verification and creates no session', async () => {
    expect((await request('/sign-in/email', { email, password })).status).toBe(403);
    expect(await (await request('/get-session')).json()).toBeNull();
  });

  it('verifies the delivered token and signs in using a real session cookie', async () => {
    const url = lastMailUrl();
    const verification = await request(`${url.pathname.slice('/api/auth'.length)}${url.search}`);
    expect([200, 302]).toContain(verification.status);
    const login = await request('/sign-in/email', { email, password });
    expect(login.status).toBe(200);
    const session = z
      .object({ user: z.object({ id: z.uuid(), emailVerified: z.boolean() }) })
      .parse(await (await request('/get-session')).json());
    expect(session.user).toMatchObject({ id: userId, emailVerified: true });
    expect([...jar.keys()].some((key) => key.includes('session_token'))).toBe(true);
  });

  it('rejects cross-origin mutation even with valid credentials', async () => {
    const response = await service.auth.handler(
      new Request(`${BASE}/api/auth/sign-in/email`, {
        method: 'POST',
        headers: { origin: 'https://evil.example.test', 'content-type': 'application/json' },
        body: JSON.stringify({ email, password }),
      }),
    );
    expect(response.status).toBe(403);
  });

  it('resets the password through delivered email and revokes previous sessions', async () => {
    const oldCookies = new Map(jar);
    expect(
      (await request('/request-password-reset', { email, redirectTo: `${BASE}/en/reset-password` }))
        .status,
    ).toBe(200);
    const reset = lastMailUrl();
    const token = reset.searchParams.get('token') ?? reset.pathname.split('/').at(-1);
    password = `ResetFixture-${crypto.randomUUID()}`;
    expect((await request('/reset-password', { token, newPassword: password })).status).toBe(200);
    expect(await (await request('/get-session', undefined, oldCookies)).json()).toBeNull();
    jar.clear();
    expect((await request('/sign-in/email', { email, password })).status).toBe(200);
  });

  it('requires a second factor after enabling and confirming a real TOTP secret', async () => {
    const enabled = await request('/two-factor/enable', { password });
    expect(enabled.status).toBe(200);
    const data = z
      .object({ totpURI: z.string(), backupCodes: z.array(z.string()) })
      .parse(await enabled.json());
    const secret = new URL(data.totpURI).searchParams.get('secret');
    if (secret === null) throw new Error('Expected test TOTP secret');
    expect((await request('/two-factor/verify-totp', { code: totp(secret) })).status).toBe(200);
    expect((await request('/sign-out', {})).status).toBe(200);
    const login = await request('/sign-in/email', { email, password });
    expect(login.status).toBe(200);
    expect(await login.json()).toMatchObject({ twoFactorRedirect: true });
    expect(await (await request('/get-session')).json()).toBeNull();
    const code = totp(secret);
    const invalid = ((Number(code) + 1) % 1_000_000).toString().padStart(6, '0');
    expect(
      (await request('/two-factor/verify-totp', { code: invalid })).status,
    ).toBeGreaterThanOrEqual(400);
    expect((await request('/two-factor/verify-totp', { code })).status).toBe(200);
    expect(await (await request('/get-session')).json()).toMatchObject({ user: { id: userId } });
  });

  it('signs out and makes the former cookie unusable immediately', async () => {
    const oldCookies = new Map(jar);
    expect((await request('/sign-out', {})).status).toBe(200);
    expect(await (await request('/get-session', undefined, oldCookies)).json()).toBeNull();
  });

  it('enforces the shared database sign-in rate limit', async () => {
    let status = 0;
    for (let attempt = 0; attempt < 12 && status !== 429; attempt += 1) {
      const response = await request('/sign-in/email', {
        email: 'nonexistent-rate-fixture@example.test',
        password: `InvalidFixture-${crypto.randomUUID()}`,
      });
      status = response.status;
    }
    expect(status).toBe(429);
  });
});
