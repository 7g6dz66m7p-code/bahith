import { eq } from 'drizzle-orm';
import { z } from 'zod';

import type { Database } from './client';
import { telegramLinks } from './schema/index';

/**
 * Telegram ↔ BAHITH links. `database` must be the authentication connection
 * (AUTH_DATABASE_URL, role bahith_auth): the application role cannot read this table.
 * Callers pass a Telegram id only after verifying Telegram's signature for a signed-in user.
 */
export type TelegramLinkSource = 'legacy_migration' | 'login_widget' | 'web_app';

export class TelegramLinkError extends Error {
  constructor(readonly code: 'TELEGRAM_LINK_INVALID' | 'TELEGRAM_LINKED_ELSEWHERE') {
    super(code);
    this.name = 'TelegramLinkError';
  }
}

const inputSchema = z.object({
  userId: z.uuid(),
  telegramUserId: z.string().regex(/^[1-9][0-9]{0,19}$/u),
  source: z.enum(['legacy_migration', 'login_widget', 'web_app']),
});

/** Links (or re-links) the user's Telegram account. A Telegram id owned by another user is refused. */
export async function linkTelegramToUser(
  authDatabase: Database,
  input: { userId: string; telegramUserId: string; source: TelegramLinkSource },
): Promise<{ telegramUserId: string }> {
  const parsed = inputSchema.safeParse(input);
  if (!parsed.success) throw new TelegramLinkError('TELEGRAM_LINK_INVALID');
  const { userId, telegramUserId, source } = parsed.data;
  try {
    return await authDatabase.db.transaction(async (tx) => {
      const [owner] = await tx
        .select({ userId: telegramLinks.userId })
        .from(telegramLinks)
        .where(eq(telegramLinks.telegramUserId, telegramUserId));
      if (owner !== undefined && owner.userId !== userId) {
        throw new TelegramLinkError('TELEGRAM_LINKED_ELSEWHERE');
      }
      if (owner === undefined) {
        // One Telegram account per user: a new link replaces the previous one. A
        // concurrent link of the same Telegram id loses on the primary key below.
        await tx.delete(telegramLinks).where(eq(telegramLinks.userId, userId));
        await tx.insert(telegramLinks).values({ telegramUserId, userId, source });
      }
      return { telegramUserId };
    });
  } catch (error) {
    const code = z
      .object({ code: z.string() })
      .safeParse(error instanceof Error ? error.cause : null);
    if (code.success && code.data.code === '23505') {
      throw new TelegramLinkError('TELEGRAM_LINKED_ELSEWHERE');
    }
    throw error;
  }
}

export async function getTelegramLink(
  authDatabase: Database,
  userId: string,
): Promise<{ telegramUserId: string; linkedAt: Date } | null> {
  if (!z.uuid().safeParse(userId).success) throw new TelegramLinkError('TELEGRAM_LINK_INVALID');
  const [row] = await authDatabase.db
    .select({ telegramUserId: telegramLinks.telegramUserId, linkedAt: telegramLinks.linkedAt })
    .from(telegramLinks)
    .where(eq(telegramLinks.userId, userId));
  return row ?? null;
}

export async function unlinkTelegram(authDatabase: Database, userId: string): Promise<boolean> {
  if (!z.uuid().safeParse(userId).success) throw new TelegramLinkError('TELEGRAM_LINK_INVALID');
  const removed = await authDatabase.db
    .delete(telegramLinks)
    .where(eq(telegramLinks.userId, userId))
    .returning({ id: telegramLinks.telegramUserId });
  return removed.length > 0;
}
