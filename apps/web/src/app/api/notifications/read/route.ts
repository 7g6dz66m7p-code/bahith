import { markNotificationsRead, SanadError } from '@bahith/db';
import { z } from 'zod';

import { apiError, readJsonBody, requireSameOrigin } from '@/server/api';
import { getDatabase } from '@/server/db';
import { unauthenticated } from '@/server/project-context';
import { getRequestSession } from '@/server/session';

const bodySchema = z.union([
  z.strictObject({ ids: z.array(z.uuid()).min(1).max(100) }),
  z.strictObject({ all: z.literal(true) }),
]);

/** Marks the session user's own notifications read: `{ids}` or `{all: true}`. */
export async function POST(request: Request) {
  try {
    const session = await getRequestSession(request);
    if (session === null) return unauthenticated();
    requireSameOrigin(request);
    const body = bodySchema.safeParse(await readJsonBody(request));
    if (!body.success) throw new SanadError('SANAD_INVALID_INPUT');
    const updated = await markNotificationsRead(
      getDatabase(),
      { userId: session.user.id },
      'all' in body.data ? 'all' : body.data.ids,
    );
    return Response.json({ updated }, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (error) {
    return apiError(error);
  }
}
