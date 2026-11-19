import type { ObjectStorage, PipelineQueues } from '@bahith/pipeline';
import {
  createPipelineQueues,
  createRedisConnection,
  createStorage,
  parseStorageConfig,
} from '@bahith/pipeline';

import { getServerEnv } from './env';

const holder = globalThis as typeof globalThis & {
  __bahithStorage?: ObjectStorage;
  __bahithQueues?: PipelineQueues;
};

/** Object storage for uploaded sources; fails with PIPELINE_CONFIG_MISSING if unset. */
export function getStorage(): ObjectStorage {
  holder.__bahithStorage ??= createStorage(parseStorageConfig(process.env));
  return holder.__bahithStorage;
}

/** Producer side of the document pipeline (BullMQ). */
export function getQueues(): PipelineQueues {
  holder.__bahithQueues ??= createPipelineQueues(createRedisConnection(getServerEnv().REDIS_URL));
  return holder.__bahithQueues;
}
