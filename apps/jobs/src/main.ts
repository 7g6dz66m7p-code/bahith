import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createDatabase, markFileFailed } from '@bahith/db';
import {
  createRedisConnection,
  createStorage,
  EXTRACT_QUEUE,
  extractJobSchema,
  INGEST_JOB,
  INGEST_QUEUE,
  parseStorageConfig,
} from '@bahith/pipeline';
import { Queue, QueueEvents, Worker } from 'bullmq';
import { z } from 'zod';

import { createIngestHandler } from './ingest';
import { errorCode, log } from './log';

const rootEnv = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../.env');
if (existsSync(rootEnv)) process.loadEnvFile(rootEnv);

const envSchema = z.object({
  DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
  REDIS_URL: z.url({ protocol: /^rediss?$/ }),
});

function main(): void {
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const names = parsed.error.issues.map((issue) => issue.path.join('.')).join(', ');
    throw new Error(`Missing or invalid environment variables: ${names}.`);
  }
  const database = createDatabase({ connectionString: parsed.data.DATABASE_URL });
  const storage = createStorage(parseStorageConfig(process.env));
  const connection = createRedisConnection(parsed.data.REDIS_URL);
  const handle = createIngestHandler({ database, storage });

  const worker = new Worker(
    INGEST_QUEUE,
    async (job) => {
      if (job.name !== INGEST_JOB) throw new Error('UNKNOWN_JOB');
      return handle(job.data);
    },
    { connection, concurrency: 2 },
  );
  worker.on('failed', (job, error) => {
    log.error('jobs.ingest_failed', {
      jobId: job?.id ?? null,
      attempts: job?.attemptsMade ?? null,
      code: errorCode(error),
    });
  });

  // An extraction that exhausted its retries in the Python worker never reaches the
  // ingest queue; mark its file failed here so it does not stay "processing" forever.
  const extractQueue = new Queue(EXTRACT_QUEUE, { connection });
  const extractEvents = new QueueEvents(EXTRACT_QUEUE, { connection: connection.duplicate() });
  extractEvents.on('failed', ({ jobId }) => {
    void (async () => {
      const job = await extractQueue.getJob(jobId);
      if (job === undefined) return;
      const attempts = job.opts.attempts ?? 1;
      if (job.attemptsMade < attempts) return;
      const payload = extractJobSchema.safeParse(job.data);
      if (!payload.success) return;
      const { userId, workspaceId, projectId, fileId } = payload.data;
      await markFileFailed(
        database,
        { userId, workspaceId, projectId },
        fileId,
        'EXTRACTION_RETRIES_EXHAUSTED',
      );
      log.warn('source.extraction_exhausted', { fileId, workspaceId, attempts });
    })().catch((error: unknown) => {
      log.error('jobs.exhausted_handler_error', { code: errorCode(error) });
    });
  });

  log.info('jobs.started', { queue: INGEST_QUEUE });
  const stop = async () => {
    log.info('jobs.stopping');
    await Promise.allSettled([worker.close(), extractEvents.close(), extractQueue.close()]);
    connection.disconnect();
    await database.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void stop());
  process.on('SIGTERM', () => void stop());
}

try {
  main();
} catch (error) {
  process.stderr.write(`error: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}
