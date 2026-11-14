import { retrieve } from '@bahith/db';
import { z } from 'zod';

import { apiError, readJsonBody, requireSameOrigin } from '@/server/api';
import { getDatabase } from '@/server/db';
import { getRequestSession } from '@/server/session';

const inputSchema = z.strictObject({
  workspaceId: z.uuid(),
  projectId: z.uuid(),
  query: z.string().trim().min(1).max(2000),
  limit: z.number().int().min(1).max(50).optional(),
});

export async function POST(request: Request) {
  try {
    const session = await getRequestSession(request);
    if (session === null) return Response.json({ code: 'AUTH_REQUIRED' }, { status: 401 });
    requireSameOrigin(request);
    const input = inputSchema.safeParse(await readJsonBody(request));
    if (!input.success) return Response.json({ code: 'SANAD_INVALID_INPUT' }, { status: 400 });
    return Response.json(await retrieve(getDatabase(), { ...input.data, userId: session.user.id }));
  } catch (error) {
    return apiError(error);
  }
}
