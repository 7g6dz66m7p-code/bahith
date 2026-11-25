import { getTelegramLink, linkTelegramToUser, TelegramLinkError, unlinkTelegram } from '@bahith/db';
import {
  TelegramAuthError,
  telegramConfigFromEnv,
  verifyLoginWidget,
  verifyWebAppInitData,
} from '@bahith/migration/telegram';
import { z } from 'zod';

import { apiError, readJsonBody, requireSameOrigin } from '@/server/api';
import { getAuthDatabase } from '@/server/db';
import { unauthenticated } from '@/server/project-context';
import { getRequestSession } from '@/server/session';

/**
 * Links the signed-in user's Telegram account. The Telegram identity is accepted only
 * with a valid Telegram signature (Login Widget fields or Mini App initData) made with
 * the existing bot's token; nothing here calls Telegram or changes the bot or its webhook.
 */
const bodySchema = z.union([
  z.strictObject({
    widget: z.record(z.string().regex(/^[a-z_]{1,32}$/u), z.string().max(512)),
  }),
  z.strictObject({ initData: z.string().min(1).max(4096) }),
]);

const STATUS: Record<string, number> = {
  TELEGRAM_NOT_CONFIGURED: 503,
  TELEGRAM_MALFORMED: 400,
  TELEGRAM_BAD_SIGNATURE: 401,
  TELEGRAM_EXPIRED: 401,
  TELEGRAM_LINK_INVALID: 400,
  TELEGRAM_LINKED_ELSEWHERE: 409,
};

function failure(error: unknown): Response {
  if (error instanceof TelegramAuthError || error instanceof TelegramLinkError) {
    return Response.json({ code: error.code }, { status: STATUS[error.code] ?? 400 });
  }
  return apiError(error);
}

export async function GET(request: Request) {
  try {
    const session = await getRequestSession(request);
    if (session === null) return unauthenticated();
    const link = await getTelegramLink(getAuthDatabase(), session.user.id);
    return Response.json(
      { linked: link !== null, telegramUserId: link?.telegramUserId ?? null },
      { headers: { 'Cache-Control': 'private, no-store' } },
    );
  } catch (error) {
    return failure(error);
  }
}

export async function POST(request: Request) {
  try {
    const session = await getRequestSession(request);
    if (session === null) return unauthenticated();
    requireSameOrigin(request);
    const body = bodySchema.safeParse(await readJsonBody(request));
    if (!body.success) throw new TelegramAuthError('TELEGRAM_MALFORMED');
    const config = telegramConfigFromEnv(process.env);
    const verified =
      'widget' in body.data
        ? verifyLoginWidget(body.data.widget, config)
        : verifyWebAppInitData(body.data.initData, config);
    await linkTelegramToUser(getAuthDatabase(), {
      userId: session.user.id,
      telegramUserId: verified.telegramUserId,
      source: verified.source,
    });
    return Response.json({ linked: true, telegramUserId: verified.telegramUserId });
  } catch (error) {
    return failure(error);
  }
}

export async function DELETE(request: Request) {
  try {
    const session = await getRequestSession(request);
    if (session === null) return unauthenticated();
    requireSameOrigin(request);
    await unlinkTelegram(getAuthDatabase(), session.user.id);
    return Response.json({ linked: false });
  } catch (error) {
    return failure(error);
  }
}
