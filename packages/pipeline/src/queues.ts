import { Queue } from 'bullmq';
import { Redis } from 'ioredis';

import type { ExtractJob, IngestJob } from './contracts';
import {
  EXTRACT_JOB,
  EXTRACT_QUEUE,
  extractJobSchema,
  INGEST_JOB,
  INGEST_QUEUE,
  ingestJobSchema,
} from './contracts';
import { PipelineError } from './errors';

/** Retries with exponential backoff; finished jobs are pruned (payloads hold ids only). */
const defaultJobOptions = {
  attempts: 3,
  backoff: { type: 'exponential', delay: 5_000 },
  removeOnComplete: { age: 24 * 3600, count: 1000 },
  removeOnFail: { age: 7 * 24 * 3600 },
} as const;

/** BullMQ needs `maxRetriesPerRequest: null` on connections that block. */
export function createRedisConnection(url: string): Redis {
  const redis = new Redis(url, { maxRetriesPerRequest: null });
  redis.on('error', () => undefined);
  return redis;
}

export interface PipelineQueues {
  enqueueExtraction(job: ExtractJob): Promise<void>;
  enqueueIngestion(job: IngestJob): Promise<void>;
  close(): Promise<void>;
}

export function createPipelineQueues(connection: Redis): PipelineQueues {
  const extract = new Queue(EXTRACT_QUEUE, { connection, defaultJobOptions });
  const ingest = new Queue(INGEST_QUEUE, { connection, defaultJobOptions });
  return {
    async enqueueExtraction(job) {
      const parsed = extractJobSchema.safeParse(job);
      if (!parsed.success) throw new PipelineError('PIPELINE_INVALID_PAYLOAD');
      // The job id is the file version: re-queuing the same file is idempotent.
      await extract.add(EXTRACT_JOB, parsed.data, { jobId: `extract-${parsed.data.fileId}` });
    },
    async enqueueIngestion(job) {
      const parsed = ingestJobSchema.safeParse(job);
      if (!parsed.success) throw new PipelineError('PIPELINE_INVALID_PAYLOAD');
      await ingest.add(INGEST_JOB, parsed.data, { jobId: `ingest-${parsed.data.fileId}` });
    },
    async close() {
      await Promise.all([extract.close(), ingest.close()]);
    },
  };
}
