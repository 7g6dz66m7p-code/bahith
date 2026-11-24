import type { Database } from '@bahith/db';
import { createDatabase } from '@bahith/db';
import type { TestDatabase } from '@bahith/db/testing';
import { startTestDatabase } from '@bahith/db/testing';
import { RedisContainer } from '@testcontainers/redis';
import type { StartedRedisContainer } from '@testcontainers/redis';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { checkHealth } from '@/lib/health';
import { dependencyProbes } from '@/server/health-probes';

/** The health probes against real Postgres and Redis containers. */
describe('dependency health probes', () => {
  let postgres: TestDatabase;
  let redisContainer: StartedRedisContainer;
  let database: Database;
  let redis: Redis;
  const cleanups: (() => void | Promise<unknown>)[] = [];

  const newRedis = (url: string) => {
    const client = new Redis(url, {
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
      retryStrategy: () => null,
    });
    client.on('error', () => undefined);
    return client;
  };

  beforeAll(async () => {
    // Assign each acquired resource so teardown also works after partial setup.
    postgres = await startTestDatabase();
    cleanups.push(() => postgres.stop());
    redisContainer = await new RedisContainer('redis:7-alpine').start();
    cleanups.push(() => redisContainer.stop());
    database = createDatabase({ connectionString: postgres.appUrl });
    cleanups.push(() => database.close());
    redis = newRedis(redisContainer.getConnectionUrl());
    cleanups.push(() => redis.disconnect());
  });

  afterAll(async () => {
    for (const cleanup of cleanups.reverse()) await cleanup();
  });

  it('reports ok when Postgres and Redis are reachable', async () => {
    const report = await checkHealth(
      dependencyProbes({ database: () => database, redis: () => redis }),
    );
    expect(report).toEqual({ status: 'ok', checks: { database: 'up', redis: 'up' } });
  });

  it('reports the database as down when it cannot be reached', async () => {
    const unreachable = createDatabase({
      connectionString: 'postgresql://bahith_app:wrong@127.0.0.1:1/bahith',
    });
    try {
      const report = await checkHealth(
        dependencyProbes({ database: () => unreachable, redis: () => redis }),
      );
      expect(report).toEqual({ status: 'degraded', checks: { database: 'down', redis: 'up' } });
    } finally {
      await unreachable.close();
    }
  });

  it('reports Redis as down when it cannot be reached', async () => {
    const unreachable = newRedis('redis://127.0.0.1:1');
    try {
      const report = await checkHealth(
        dependencyProbes({ database: () => database, redis: () => unreachable }),
      );
      expect(report).toEqual({ status: 'degraded', checks: { database: 'up', redis: 'down' } });
    } finally {
      unreachable.disconnect();
    }
  });
});
