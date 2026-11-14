import type { Database } from '@bahith/db';
import type { Redis } from 'ioredis';

import type { HealthProbe } from '@/lib/health';

/** Probes for the services the web app depends on. */
export function dependencyProbes(deps: {
  database: () => Database;
  redis: () => Redis;
}): Record<string, HealthProbe> {
  return {
    database: () => deps.database().pool.query('SELECT 1'),
    redis: async () => {
      const redis = deps.redis();
      if (redis.status === 'wait' || redis.status === 'end') {
        await redis.connect();
      }
      await redis.ping();
    },
  };
}
