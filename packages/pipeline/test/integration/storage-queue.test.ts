import { randomUUID } from 'node:crypto';

import { Queue } from 'bullmq';
import { GenericContainer, Wait } from 'testcontainers';
import type { StartedTestContainer } from 'testcontainers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { EXTRACT_QUEUE } from '../../src/contracts';
import { fileObjectKey } from '../../src/keys';
import { createPipelineQueues, createRedisConnection } from '../../src/queues';
import type { ObjectStorage } from '../../src/storage';
import { createStorage } from '../../src/storage';

const MINIO_IMAGE = 'coollabsio/minio:RELEASE.2025-10-15T17-29-55Z';

describe('object storage and queues against real MinIO and Redis', () => {
  let minio: StartedTestContainer;
  let redis: StartedTestContainer;
  let storage: ObjectStorage;
  // Throwaway credentials that exist only inside the test container.
  const accessKeyId = `test-${randomUUID().slice(0, 8)}`;
  const secretAccessKey = randomUUID();

  beforeAll(async () => {
    [minio, redis] = await Promise.all([
      new GenericContainer(MINIO_IMAGE)
        .withEnvironment({ MINIO_ROOT_USER: accessKeyId, MINIO_ROOT_PASSWORD: secretAccessKey })
        .withCommand(['server', '/data'])
        .withExposedPorts(9000)
        .withWaitStrategy(Wait.forHttp('/minio/health/live', 9000))
        .start(),
      new GenericContainer('redis:7-alpine').withExposedPorts(6379).start(),
    ]);
    storage = createStorage({
      endpoint: `http://${minio.getHost()}:${minio.getMappedPort(9000)}`,
      region: 'us-east-1',
      bucket: 'bahith-test',
      accessKeyId,
      secretAccessKey,
      forcePathStyle: true,
    });
    await storage.ensureBucket();
  });

  afterAll(async () => {
    await Promise.all([minio.stop(), redis.stop()]);
  });

  const key = () => fileObjectKey(randomUUID(), randomUUID());

  it('stores and reads back exact bytes, including Arabic text', async () => {
    const objectKey = key();
    const bytes = new TextEncoder().encode('الْمَنْهَجُ العِلْمِيّ — exact bytes');
    await storage.put(objectKey, bytes, 'text/plain');
    expect(Buffer.from(await storage.getBytes(objectKey, 1024)).equals(Buffer.from(bytes))).toBe(
      true,
    );
  });

  it('refuses to read an object larger than the caller allows', async () => {
    const objectKey = key();
    await storage.put(objectKey, new Uint8Array(2048), 'application/octet-stream');
    await expect(storage.getBytes(objectKey, 1024)).rejects.toMatchObject({
      code: 'STORAGE_TOO_LARGE',
    });
  });

  it('reports a missing object as STORAGE_NOT_FOUND and deletes idempotently', async () => {
    const objectKey = key();
    await expect(storage.getBytes(objectKey, 10)).rejects.toMatchObject({
      code: 'STORAGE_NOT_FOUND',
    });
    await storage.put(objectKey, new Uint8Array([1]), 'application/octet-stream');
    await storage.delete(objectKey);
    await storage.delete(objectKey);
    await expect(storage.getBytes(objectKey, 10)).rejects.toMatchObject({
      code: 'STORAGE_NOT_FOUND',
    });
  });

  it('enqueues an extraction job once per file, with retries configured', async () => {
    const connection = createRedisConnection(
      `redis://${redis.getHost()}:${redis.getMappedPort(6379)}`,
    );
    const queues = createPipelineQueues(connection);
    const inspect = new Queue(EXTRACT_QUEUE, { connection });
    try {
      const job = {
        userId: randomUUID(),
        workspaceId: randomUUID(),
        projectId: randomUUID(),
        fileId: randomUUID(),
        storageKey: 'workspaces/x/files/y',
        mimeType: 'application/pdf' as const,
        sha256: 'a'.repeat(64),
      };
      await queues.enqueueExtraction(job);
      await queues.enqueueExtraction(job);
      const waiting = await inspect.getWaiting();
      const mine = waiting.filter((entry) => entry.id === `extract-${job.fileId}`);
      expect(mine).toHaveLength(1);
      expect(mine[0]?.data).toEqual(job);
      expect(mine[0]?.opts.attempts).toBe(3);
      await expect(
        queues.enqueueExtraction({ ...job, mimeType: 'application/zip' } as never),
      ).rejects.toMatchObject({ code: 'PIPELINE_INVALID_PAYLOAD' });
    } finally {
      await inspect.close();
      await queues.close();
      connection.disconnect();
    }
  });
});
