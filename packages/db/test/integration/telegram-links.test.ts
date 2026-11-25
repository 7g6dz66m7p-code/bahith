import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { createDatabase } from '../../src/client';
import type { Database } from '../../src/index';
import {
  getTelegramLink,
  linkTelegramToUser,
  schema,
  TelegramLinkError,
  unlinkTelegram,
} from '../../src/index';

describe('Telegram links (authentication connection only)', () => {
  let app: Database;
  let auth: Database;
  let a: string;
  let b: string;

  beforeAll(async () => {
    app = createDatabase({ connectionString: inject('appUrl'), max: 1 });
    auth = createDatabase({ connectionString: inject('authUrl'), max: 1 });
    const suffix = crypto.randomUUID();
    const make = async (label: string) => {
      const [row] = await auth.db
        .insert(schema.users)
        .values({ name: `Telegram ${label}`, email: `tg-${label}-${suffix}@example.test` })
        .returning({ id: schema.users.id });
      if (row === undefined) throw new Error('user not created');
      return row.id;
    };
    a = await make('a');
    b = await make('b');
  });

  afterAll(async () => {
    await app.close();
    await auth.close();
  });

  it('links, keeps one Telegram account per user and refuses a Telegram id owned by someone else', async () => {
    await linkTelegramToUser(auth, { userId: a, telegramUserId: '1001', source: 'login_widget' });
    expect(await getTelegramLink(auth, a)).toMatchObject({ telegramUserId: '1001' });
    // Linking again is idempotent.
    await linkTelegramToUser(auth, { userId: a, telegramUserId: '1001', source: 'login_widget' });
    await expect(
      linkTelegramToUser(auth, { userId: b, telegramUserId: '1001', source: 'web_app' }),
    ).rejects.toEqual(new TelegramLinkError('TELEGRAM_LINKED_ELSEWHERE'));
    // A new Telegram account replaces the user's previous one.
    await linkTelegramToUser(auth, { userId: a, telegramUserId: '1002', source: 'web_app' });
    expect(await getTelegramLink(auth, a)).toMatchObject({ telegramUserId: '1002' });
    await linkTelegramToUser(auth, { userId: b, telegramUserId: '1001', source: 'web_app' });
    expect(await getTelegramLink(auth, b)).toMatchObject({ telegramUserId: '1001' });
    expect(await unlinkTelegram(auth, a)).toBe(true);
    expect(await getTelegramLink(auth, a)).toBeNull();
    expect(await unlinkTelegram(auth, a)).toBe(false);
  });

  it('rejects malformed ids before touching the database', async () => {
    for (const telegramUserId of ['0', '-5', 'abc', '1'.repeat(21)]) {
      await expect(
        linkTelegramToUser(auth, { userId: a, telegramUserId, source: 'login_widget' }),
      ).rejects.toEqual(new TelegramLinkError('TELEGRAM_LINK_INVALID'));
    }
  });

  it('the application role can neither read nor write links', async () => {
    await expect(getTelegramLink(app, b)).rejects.toMatchObject({ cause: { code: '42501' } });
    await expect(
      linkTelegramToUser(app, { userId: b, telegramUserId: '1003', source: 'login_widget' }),
    ).rejects.toMatchObject({ cause: { code: '42501' } });
  });
});
