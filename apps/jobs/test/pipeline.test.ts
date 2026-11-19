/**
 * End-to-end document pipeline with real services and the real Python worker:
 *
 *   register upload ─▶ MinIO ─▶ sanad.extract ─▶ Python worker (OCR) ─▶ manifest in MinIO
 *   ─▶ sanad.ingest ─▶ this Node handler ─▶ PostgreSQL (RLS) ─▶ retrievable evidence
 *
 * The scanned page is a Chromium-rendered image of synthetic Arabic test text
 * (apps/worker/tests/fixtures/ocr), saved as an image-only PDF.
 */
import { spawn, spawnSync } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';

import type { Database } from '@bahith/db';
import {
  createDatabase,
  createProject,
  getProjectFile,
  listProjectLibrary,
  markFileQueued,
  registerUpload,
  retrieve,
  schema,
} from '@bahith/db';
import { eq } from '@bahith/db/orm';
import type { TestDatabase } from '@bahith/db/testing';
import { startTestDatabase } from '@bahith/db/testing';
import type { ObjectStorage } from '@bahith/pipeline';
import {
  createPipelineQueues,
  createRedisConnection,
  createStorage,
  fileObjectKey,
  INGEST_QUEUE,
} from '@bahith/pipeline';
import { Worker } from 'bullmq';
import type { Redis } from 'ioredis';
import { GenericContainer, Wait } from 'testcontainers';
import type { StartedTestContainer } from 'testcontainers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createIngestHandler } from '../src/ingest';

const ROOT = path.resolve(import.meta.dirname, '../../..');
const WORKER_DIR = path.join(ROOT, 'apps/worker');
const MINIO_IMAGE = 'coollabsio/minio:RELEASE.2025-10-15T17-29-55Z';

/** An image-only PDF built in Python from the OCR fixture (no text layer at all). */
function scannedPdf(): Buffer {
  const script = [
    'import sys, io',
    'from PIL import Image',
    `img = Image.open(${JSON.stringify(path.join(WORKER_DIR, 'tests/fixtures/ocr/arabic-page.png'))}).convert("RGB")`,
    'buf = io.BytesIO()',
    'img.save(buf, format="PDF", resolution=300)',
    'sys.stdout.buffer.write(buf.getvalue())',
  ].join('\n');
  return execBytes('uv', ['run', '--quiet', 'python', '-c', script], WORKER_DIR);
}

function execBytes(command: string, args: string[], cwd: string): Buffer {
  const result = spawnSync(command, args, { cwd, maxBuffer: 50 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`${command} failed`);
  return result.stdout;
}

async function waitFor<T>(probe: () => Promise<T | undefined>, timeoutMs: number): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error('timed out waiting for the pipeline');
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

describe('document pipeline: upload → Python OCR worker → Node ingestion → SANAD', () => {
  let db: TestDatabase;
  let minio: StartedTestContainer;
  let redisContainer: StartedTestContainer;
  let database: Database;
  let storage: ObjectStorage;
  let connection: Redis;
  let ingestWorker: Worker;
  let python: ChildProcess;
  let context: { userId: string; workspaceId: string; projectId: string };
  // Throwaway credentials that exist only inside the test containers.
  const s3User = `test-${randomUUID().slice(0, 8)}`;
  const s3Secret = randomUUID();

  beforeAll(async () => {
    [db, minio, redisContainer] = await Promise.all([
      startTestDatabase(),
      new GenericContainer(MINIO_IMAGE)
        .withEnvironment({ MINIO_ROOT_USER: s3User, MINIO_ROOT_PASSWORD: s3Secret })
        .withCommand(['server', '/data'])
        .withExposedPorts(9000)
        .withWaitStrategy(Wait.forHttp('/minio/health/live', 9000))
        .start(),
      new GenericContainer('redis:7-alpine').withExposedPorts(6379).start(),
    ]);
    const s3Endpoint = `http://${minio.getHost()}:${minio.getMappedPort(9000)}`;
    const redisUrl = `redis://${redisContainer.getHost()}:${redisContainer.getMappedPort(6379)}`;
    storage = createStorage({
      endpoint: s3Endpoint,
      region: 'us-east-1',
      bucket: 'bahith-pipeline-test',
      accessKeyId: s3User,
      secretAccessKey: s3Secret,
      forcePathStyle: true,
    });
    await storage.ensureBucket();

    database = createDatabase({ connectionString: db.appUrl });
    const auth = createDatabase({ connectionString: db.authUrl });
    const [user] = await auth.db
      .insert(schema.users)
      .values({ email: `pipeline-${randomUUID()}@example.test`, name: 'Pipeline Test' })
      .returning({ id: schema.users.id });
    await auth.close();
    const userId = user?.id ?? '';
    const [workspace] = await database.withUser(userId, (tx) =>
      tx.select({ id: schema.workspaces.id }).from(schema.workspaces),
    );
    const workspaceId = workspace?.id ?? '';
    const project = await createProject(database, userId, {
      workspaceId,
      title: 'مشروع خط المعالجة',
    });
    context = { userId, workspaceId, projectId: project.id };

    connection = createRedisConnection(redisUrl);
    ingestWorker = new Worker(
      INGEST_QUEUE,
      (job) => createIngestHandler({ database, storage })(job.data),
      { connection: connection.duplicate() },
    );

    // The real Python worker, configured like production (env vars override .env).
    python = spawn('uv', ['run', '--quiet', 'python', '-m', 'bahith_worker'], {
      cwd: WORKER_DIR,
      env: {
        ...process.env,
        REDIS_URL: redisUrl,
        S3_ENDPOINT: s3Endpoint,
        S3_REGION: 'us-east-1',
        S3_BUCKET: 'bahith-pipeline-test',
        S3_ACCESS_KEY_ID: s3User,
        S3_SECRET_ACCESS_KEY: s3Secret,
        S3_FORCE_PATH_STYLE: 'true',
      },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
  });

  afterAll(async () => {
    python.kill('SIGTERM');
    await ingestWorker.close();
    connection.disconnect();
    await database.close();
    await Promise.all([db.stop(), minio.stop(), redisContainer.stop()]);
  });

  async function upload(bytes: Buffer, mimeType: 'application/pdf' | 'text/plain', name: string) {
    const fileId = randomUUID();
    const storageKey = fileObjectKey(context.workspaceId, fileId);
    await storage.put(storageKey, bytes, mimeType);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const registered = await registerUpload(database, context, {
      fileId,
      originalName: name,
      mimeType,
      sizeBytes: bytes.byteLength,
      sha256,
      storageKey,
    });
    const queues = createPipelineQueues(connection.duplicate());
    await queues.enqueueExtraction({ ...context, fileId, storageKey, mimeType, sha256 });
    await queues.close();
    await markFileQueued(database, context, fileId);
    return registered;
  }

  async function settled(fileId: string) {
    return waitFor(async () => {
      const file = await getProjectFile(database, context, fileId);
      return file.status === 'ready' || file.status === 'failed' ? file : undefined;
    }, 120_000);
  }

  it('OCRs a scanned Arabic page and makes it retrievable with its real page number', async () => {
    const { fileId } = await upload(scannedPdf(), 'application/pdf', 'مخطوطة_ممسوحة.pdf');
    const file = await settled(fileId);
    expect(file.status).toBe('ready');

    const [entry] = (await listProjectLibrary(database, context)).filter((item) =>
      item.files.some((f) => f.id === fileId),
    );
    expect(entry?.fullTextStatus).toBe('full_text');
    expect(entry?.files[0]).toMatchObject({ status: 'ready', pageCount: 1, ocrUsed: true });

    const result = await retrieve(database, { ...context, query: 'المصادر الأصلية', limit: 5 });
    const hit = result.results.find((item) => item.fileId === fileId);
    expect(hit).toBeDefined();
    expect(hit?.pageStart).toBe(1);
    expect(hit?.content).toContain('تحليل المصادر الأصلية');

    const [chunk] = await database.withWorkspace(context.workspaceId, (tx) =>
      tx
        .select({ provenance: schema.chunks.provenance })
        .from(schema.chunks)
        .where(eq(schema.chunks.fileId, fileId)),
    );
    expect(chunk?.provenance).toMatchObject({ extractionMethod: 'ocr' });
  });

  it('records a corrupt upload as failed with a stable code, never as text', async () => {
    const { fileId } = await upload(Buffer.from('%PDF-1.7 corrupt'), 'application/pdf', 'تالف.pdf');
    const file = await settled(fileId);
    expect(file.status).toBe('failed');
    const audit = await database.withWorkspace(context.workspaceId, (tx) =>
      tx
        .select({ action: schema.auditLog.action, metadata: schema.auditLog.metadata })
        .from(schema.auditLog),
    );
    expect(audit).toContainEqual({
      action: 'source.processing_failed',
      metadata: { code: 'INVALID_DOCUMENT' },
    });
  });

  it('a plain UTF-8 Arabic text file is ingested without OCR', async () => {
    const text = Buffer.from('يدرس هذا البحث أثر التعليم عن بعد على تحصيل الطلاب', 'utf8');
    const { fileId } = await upload(text, 'text/plain', 'ملاحظات.txt');
    expect((await settled(fileId)).status).toBe('ready');
    const result = await retrieve(database, { ...context, query: 'التعليم عن بعد', limit: 5 });
    const hit = result.results.find((item) => item.fileId === fileId);
    expect(hit?.pageStart).toBeNull();
  });
});
