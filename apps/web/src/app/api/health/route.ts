import { checkHealth } from '@/lib/health';
import { getDatabase } from '@/server/db';
import { dependencyProbes } from '@/server/health-probes';
import { getRedis } from '@/server/redis';

export const dynamic = 'force-dynamic';

/** Liveness of the app and its dependencies: 200 when all are up, 503 otherwise. */
export async function GET(): Promise<Response> {
  const report = await checkHealth(dependencyProbes({ database: getDatabase, redis: getRedis }));
  return Response.json(report, {
    status: report.status === 'ok' ? 200 : 503,
    headers: { 'Cache-Control': 'no-store' },
  });
}
