import { createHash, createHmac } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  dataCheckString,
  linkTelegramAccount,
  telegramConfigFromEnv,
  TelegramAuthError,
  verifyLoginWidget,
  verifyWebAppInitData,
} from '../../src/telegram';

// A fake token that exists only in this test; no network call is made anywhere.
const FAKE_TOKEN = `123456:${'test-only-'.repeat(3)}`;
const config = { botToken: FAKE_TOKEN, maxAgeSeconds: 3600 };
const now = new Date('2026-01-01T12:00:00Z');
const authDate = String(Math.floor(now.getTime() / 1000) - 60);

function signWidget(fields: Record<string, string>, token = FAKE_TOKEN): Record<string, string> {
  const secret = createHash('sha256').update(token).digest();
  const hash = createHmac('sha256', secret).update(dataCheckString(fields)).digest('hex');
  return { ...fields, hash };
}

function signWebApp(fields: Record<string, string>, token = FAKE_TOKEN): string {
  const secret = createHmac('sha256', 'WebAppData').update(token).digest();
  const hash = createHmac('sha256', secret).update(dataCheckString(fields)).digest('hex');
  return new URLSearchParams({ ...fields, hash }).toString();
}

const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (error) {
    return error instanceof TelegramAuthError ? error.code : 'OTHER';
  }
  return 'NONE';
};

describe('Telegram Login Widget', () => {
  const fields = { id: '987654321', first_name: 'T', username: 'u', auth_date: authDate };

  it('builds the data-check-string sorted, without hash', () => {
    expect(dataCheckString({ b: '2', hash: 'x', a: '1' })).toBe('a=1\nb=2');
  });

  it('accepts a correctly signed payload', () => {
    expect(verifyLoginWidget(signWidget(fields), config, now)).toEqual({
      telegramUserId: '987654321',
      authDate: new Date(Number(authDate) * 1000),
      source: 'login_widget',
    });
  });

  it('rejects tampering, a wrong token, bad hashes and stale or future dates', () => {
    const signed = signWidget(fields);
    expect(code(() => verifyLoginWidget({ ...signed, id: '1' }, config, now))).toBe(
      'TELEGRAM_BAD_SIGNATURE',
    );
    expect(code(() => verifyLoginWidget(signWidget(fields, 'other:token'), config, now))).toBe(
      'TELEGRAM_BAD_SIGNATURE',
    );
    expect(code(() => verifyLoginWidget({ ...signed, hash: 'zz' }, config, now))).toBe(
      'TELEGRAM_BAD_SIGNATURE',
    );
    expect(
      code(() =>
        verifyLoginWidget({ ...signed, hash: signed['hash']?.toUpperCase() ?? '' }, config, now),
      ),
    ).toBe('NONE');
    const { hash: _hash, ...unsigned } = signed;
    expect(code(() => verifyLoginWidget(unsigned, config, now))).toBe('TELEGRAM_MALFORMED');
    const stale = signWidget({
      ...fields,
      auth_date: String(Math.floor(now.getTime() / 1000) - 7200),
    });
    expect(code(() => verifyLoginWidget(stale, config, now))).toBe('TELEGRAM_EXPIRED');
    const future = signWidget({
      ...fields,
      auth_date: String(Math.floor(now.getTime() / 1000) + 3600),
    });
    expect(code(() => verifyLoginWidget(future, config, now))).toBe('TELEGRAM_EXPIRED');
    expect(code(() => verifyLoginWidget(signWidget(fields), { botToken: '' }, now))).toBe(
      'TELEGRAM_NOT_CONFIGURED',
    );
  });
});

describe('Telegram Mini App initData', () => {
  const fields = {
    query_id: 'AAE',
    user: JSON.stringify({ id: 42424242, first_name: 'T' }),
    auth_date: authDate,
  };

  it('accepts a correctly signed initData string', () => {
    expect(verifyWebAppInitData(signWebApp(fields), config, now)).toMatchObject({
      telegramUserId: '42424242',
      source: 'web_app',
    });
  });

  it('does not accept a Login Widget signature for initData (different secret derivation)', () => {
    const widgetSigned = new URLSearchParams(signWidget(fields)).toString();
    expect(code(() => verifyWebAppInitData(widgetSigned, config, now))).toBe(
      'TELEGRAM_BAD_SIGNATURE',
    );
  });

  it('rejects a swapped user, duplicate keys, a bad user field and a stale date', () => {
    const signed = new URLSearchParams(signWebApp(fields));
    signed.set('user', JSON.stringify({ id: 1 }));
    expect(code(() => verifyWebAppInitData(signed.toString(), config, now))).toBe(
      'TELEGRAM_BAD_SIGNATURE',
    );
    expect(code(() => verifyWebAppInitData(`${signWebApp(fields)}&auth_date=1`, config, now))).toBe(
      'TELEGRAM_MALFORMED',
    );
    expect(
      code(() => verifyWebAppInitData(signWebApp({ ...fields, user: 'nope' }), config, now)),
    ).toBe('TELEGRAM_MALFORMED');
    const stale = signWebApp({ ...fields, auth_date: '1000' });
    expect(code(() => verifyWebAppInitData(stale, config, now))).toBe('TELEGRAM_EXPIRED');
  });
});

describe('config and linking', () => {
  it('requires the bot token from the environment', () => {
    expect(code(() => telegramConfigFromEnv({}))).toBe('TELEGRAM_NOT_CONFIGURED');
    expect(
      telegramConfigFromEnv({
        TELEGRAM_BOT_TOKEN: FAKE_TOKEN,
        TELEGRAM_AUTH_MAX_AGE_SECONDS: '60',
      }),
    ).toEqual({
      botToken: FAKE_TOKEN,
      maxAgeSeconds: 60,
    });
  });

  it('links a verified Telegram id through the migrated link store', async () => {
    const store = {
      findUserIdByTelegramId: (id: string) =>
        Promise.resolve(id === '42424242' ? '00000000-0000-4000-8000-000000000001' : null),
    };
    const verified = verifyWebAppInitData(signWebApp(fields()), config, now);
    expect(await linkTelegramAccount(verified, store)).toEqual({
      status: 'linked',
      userId: '00000000-0000-4000-8000-000000000001',
      telegramUserId: '42424242',
    });
    expect(await linkTelegramAccount({ ...verified, telegramUserId: '7' }, store)).toEqual({
      status: 'not_migrated',
      telegramUserId: '7',
    });
  });
});

function fields() {
  return { user: JSON.stringify({ id: 42424242 }), auth_date: authDate };
}
