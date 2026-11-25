import { getPlatformStats, listPlans } from '@bahith/db';

import { apiError } from '@/server/api';
import { getDatabase } from '@/server/db';
import { isPlatformAdmin } from '@/server/platform-admin';
import { unauthenticated } from '@/server/project-context';
import { getRequestSession } from '@/server/session';

/** Aggregate platform numbers and the plan catalogue (platform administrators only). */
export async function GET(request: Request) {
  try {
    const session = await getRequestSession(request);
    if (session === null) return unauthenticated();
    if (!isPlatformAdmin(session)) return Response.json({ code: 'ADMIN_ONLY' }, { status: 404 });
    const database = getDatabase();
    const [stats, plans] = await Promise.all([getPlatformStats(database), listPlans(database)]);
    return Response.json({ stats, plans }, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (error) {
    return apiError(error);
  }
}
