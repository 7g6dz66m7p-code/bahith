import { listNotifications, SanadError } from '@bahith/db';
import { z } from 'zod';

import { apiError } from '@/server/api';
import { getDatabase } from '@/server/db';
import { unauthenticated } from '@/server/project-context';
import { getRequestSession } from '@/server/session';

const querySchema = z.strictObject({
  unread: z.enum(['1']).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

/**
 * The signed-in user's notifications across their workspaces, newest first, and the
 * unread count. The recipient is always the session user; there is no user parameter.
 */
export async function GET(request: Request) {
  try {
    const session = await getRequestSession(request);
    if (session === null) return unauthenticated();
    const query = querySchema.safeParse(Object.fromEntries(new URL(request.url).searchParams));
    if (!query.success) throw new SanadError('SANAD_INVALID_INPUT');
    const result = await listNotifications(
      getDatabase(),
      { userId: session.user.id },
      { unreadOnly: query.data.unread === '1', limit: query.data.limit ?? 30 },
    );
    return Response.json(result, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (error) {
    return apiError(error);
  }
}
