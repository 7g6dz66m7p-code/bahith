import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

import { z } from 'zod';

/**
 * Telegram bridge for migrated accounts. It only VERIFIES data that Telegram already
 * signed for the user (Login Widget or Mini App `initData`) and maps the Telegram user
 * id to a migrated BAHITH user. It never calls the Telegram Bot API and never touches
 * the legacy bot's webhook.
 *
 * Signature algorithms (core.telegram.org/widgets/login, core.telegram.org/bots/webapps):
 * - Login Widget: secret = SHA256(bot_token); hash = HMAC_SHA256(secret, data_check_string)
 * - Mini App:     secret = HMAC_SHA256("WebAppData", bot_token); hash = HMAC_SHA256(secret, data_check_string)
 * data_check_string = every received field except `hash`, as `key=value`, sorted by key, joined by "\n".
 */

export class TelegramAuthError extends Error {
  constructor(
    readonly code:
      | 'TELEGRAM_NOT_CONFIGURED'
      | 'TELEGRAM_MALFORMED'
      | 'TELEGRAM_BAD_SIGNATURE'
      | 'TELEGRAM_EXPIRED',
  ) {
    super(code);
    this.name = 'TelegramAuthError';
  }
}

export interface TelegramConfig {
  botToken: string;
  /** Maximum accepted age of `auth_date`, in seconds (default 1 day). */
  maxAgeSeconds?: number;
}

/** Reads the bot token from the environment; fails clearly when it is absent. */
export function telegramConfigFromEnv(env: NodeJS.ProcessEnv = process.env): TelegramConfig {
  const botToken = env['TELEGRAM_BOT_TOKEN'];
  if (botToken === undefined || botToken.trim() === '') {
    throw new TelegramAuthError('TELEGRAM_NOT_CONFIGURED');
  }
  const maxAge = env['TELEGRAM_AUTH_MAX_AGE_SECONDS'];
  return {
    botToken,
    ...(maxAge !== undefined && /^\d+$/.test(maxAge) ? { maxAgeSeconds: Number(maxAge) } : {}),
  };
}

export interface VerifiedTelegramUser {
  telegramUserId: string;
  authDate: Date;
  source: 'login_widget' | 'web_app';
}

export function dataCheckString(fields: Record<string, string>): string {
  return Object.keys(fields)
    .filter((key) => key !== 'hash')
    .sort()
    .map((key) => `${key}=${fields[key] ?? ''}`)
    .join('\n');
}

function safeEqualHex(expectedHex: string, receivedHex: string): boolean {
  if (!/^[0-9a-f]{64}$/i.test(receivedHex)) return false;
  const a = Buffer.from(expectedHex, 'hex');
  const b = Buffer.from(receivedHex.toLowerCase(), 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

function checkAge(authDateRaw: string | undefined, config: TelegramConfig, now: Date): Date {
  if (authDateRaw === undefined || !/^\d{1,12}$/.test(authDateRaw)) {
    throw new TelegramAuthError('TELEGRAM_MALFORMED');
  }
  const authDate = new Date(Number(authDateRaw) * 1000);
  const ageSeconds = (now.getTime() - authDate.getTime()) / 1000;
  const maxAge = config.maxAgeSeconds ?? 86_400;
  // A small allowance for clock skew; a date far in the future is not accepted.
  if (ageSeconds > maxAge || ageSeconds < -60) throw new TelegramAuthError('TELEGRAM_EXPIRED');
  return authDate;
}

function requireToken(config: TelegramConfig): string {
  if (config.botToken.trim() === '') throw new TelegramAuthError('TELEGRAM_NOT_CONFIGURED');
  return config.botToken;
}

const telegramId = z.string().regex(/^[1-9]\d{0,19}$/);

/** Verifies the fields the Login Widget passes to the redirect / callback. */
export function verifyLoginWidget(
  fields: Record<string, string>,
  config: TelegramConfig,
  now: Date = new Date(),
): VerifiedTelegramUser {
  const token = requireToken(config);
  const hash = fields['hash'];
  const id = telegramId.safeParse(fields['id']);
  if (hash === undefined || !id.success) throw new TelegramAuthError('TELEGRAM_MALFORMED');
  const secret = createHash('sha256').update(token).digest();
  const expected = createHmac('sha256', secret).update(dataCheckString(fields)).digest('hex');
  // Signature first, then freshness: an attacker learns nothing about the age check.
  if (!safeEqualHex(expected, hash)) throw new TelegramAuthError('TELEGRAM_BAD_SIGNATURE');
  const authDate = checkAge(fields['auth_date'], config, now);
  return { telegramUserId: id.data, authDate, source: 'login_widget' };
}

/** Verifies a Mini App `Telegram.WebApp.initData` query string. */
export function verifyWebAppInitData(
  initData: string,
  config: TelegramConfig,
  now: Date = new Date(),
): VerifiedTelegramUser {
  const token = requireToken(config);
  const params = new URLSearchParams(initData);
  const fields: Record<string, string> = {};
  for (const [key, value] of params) {
    if (key in fields) throw new TelegramAuthError('TELEGRAM_MALFORMED');
    fields[key] = value;
  }
  const hash = fields['hash'];
  if (hash === undefined) throw new TelegramAuthError('TELEGRAM_MALFORMED');
  const secret = createHmac('sha256', 'WebAppData').update(token).digest();
  const expected = createHmac('sha256', secret).update(dataCheckString(fields)).digest('hex');
  if (!safeEqualHex(expected, hash)) throw new TelegramAuthError('TELEGRAM_BAD_SIGNATURE');
  const authDate = checkAge(fields['auth_date'], config, now);
  let user: unknown;
  try {
    user = JSON.parse(fields['user'] ?? '');
  } catch {
    throw new TelegramAuthError('TELEGRAM_MALFORMED');
  }
  const parsed = z
    .object({ id: z.union([z.number().int().positive(), telegramId]) })
    .safeParse(user);
  if (!parsed.success) throw new TelegramAuthError('TELEGRAM_MALFORMED');
  const id = telegramId.safeParse(String(parsed.data.id));
  if (!id.success) throw new TelegramAuthError('TELEGRAM_MALFORMED');
  return { telegramUserId: id.data, authDate, source: 'web_app' };
}

/** Lookup of migrated Telegram links: Telegram user id → new-platform user id. */
export interface TelegramLinkStore {
  findUserIdByTelegramId(telegramUserId: string): Promise<string | null>;
}

export type LinkResult =
  | { status: 'linked'; userId: string; telegramUserId: string }
  | { status: 'not_migrated'; telegramUserId: string };

/**
 * Maps an already VERIFIED Telegram identity to the migrated BAHITH user. The caller
 * must still require the user to be signed in to that account (or complete an e-mail
 * proof) before treating the link as a login — a Telegram link alone is not a session.
 */
export async function linkTelegramAccount(
  verified: VerifiedTelegramUser,
  store: TelegramLinkStore,
): Promise<LinkResult> {
  const userId = await store.findUserIdByTelegramId(verified.telegramUserId);
  return userId === null
    ? { status: 'not_migrated', telegramUserId: verified.telegramUserId }
    : { status: 'linked', userId, telegramUserId: verified.telegramUserId };
}
