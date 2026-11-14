import { Redis } from 'ioredis';

import { getServerEnv } from './env';

const holder = globalThis as typeof globalThis & { __bahithRedis?: Redis };

/** Shared Redis connection (BullMQ queues will reuse it from Phase 3). */
export function getRedis(): Redis {
  if (holder.__bahithRedis === undefined) {
    const redis = new Redis(getServerEnv().REDIS_URL, {
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
    });
    // Connection errors surface through the failing command; without a listener
    // ioredis would print them (including the URL) to stderr.
    redis.on('error', () => undefined);
    holder.__bahithRedis = redis;
  }
  return holder.__bahithRedis;
}
