/** Starts a disposable database and ingests the committed corpus through the real extractor. */
// Must stay the first import: it captures the proxy dispatcher before Testcontainers loads.
import { restoreProxyDispatcher } from './proxy-dispatcher';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import {
  createDatabase,
  createProject,
  ingestExtraction,
  registerUpload,
  schema,
} from '@bahith/db';
import type { Database } from '@bahith/db';
import { seedReferenceData, startTestDatabase } from '@bahith/db/testing';

import { CORPUS_DIR, loadCorpus } from './corpus-schema';
import type { Corpus } from './corpus-schema';

const run = promisify(execFile);
const ROOT = path.resolve(import.meta.dirname, '../..');

export interface IngestedCorpus {
  corpus: Corpus;
  app: Database;
  admin: Database;
  ctx: { userId: string; workspaceId: string; projectId: string };
  /** Corpus document id → source id. */
  sourceOf: Map<string, string>;
  extraction: Record<string, unknown>[];
}

export async function withIngestedCorpus<T>(fn: (env: IngestedCorpus) => Promise<T>): Promise<T> {
  const corpus = await loadCorpus();
  const database = await startTestDatabase();
  restoreProxyDispatcher();
  const admin = createDatabase({ connectionString: database.adminUrl });
  const app = createDatabase({ connectionString: database.appUrl });
  const auth = createDatabase({ connectionString: database.authUrl });
  try {
    const client = await admin.pool.connect();
    try {
      await seedReferenceData(client);
    } finally {
      client.release();
    }
    const [user] = await auth.db
      .insert(schema.users)
      .values({ email: `eval-${randomUUID()}@example.test`, name: 'SANAD evaluation' })
      .returning({ id: schema.users.id });
    if (user === undefined) throw new Error('user not created');
    const [workspace] = await app.withUser(user.id, (tx) =>
      tx.select({ id: schema.workspaces.id }).from(schema.workspaces),
    );
    if (workspace === undefined) throw new Error('personal workspace missing');
    const project = await createProject(app, user.id, {
      workspaceId: workspace.id,
      title: 'SANAD evaluation',
    });
    const ctx = { userId: user.id, workspaceId: workspace.id, projectId: project.id };

    // Ingest every document through the real extractor.
    const sourceOf = new Map<string, string>();
    const extraction: Record<string, unknown>[] = [];
    for (const document of corpus.documents) {
      const filePath = path.join(CORPUS_DIR, document.fileName);
      const bytes = await readFile(filePath);
      const fileId = randomUUID();
      const upload = await registerUpload(app, ctx, {
        fileId,
        originalName: document.fileName,
        mimeType: 'application/pdf',
        sizeBytes: bytes.byteLength,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        storageKey: `workspaces/${workspace.id}/files/${fileId}/original`,
      });
      const t0 = Date.now();
      const { stdout } = await run(
        'uv',
        [
          'run',
          '--quiet',
          '--project',
          path.join(ROOT, 'apps/worker'),
          'python',
          '-I',
          path.join(import.meta.dirname, 'extract.py'),
          filePath,
          'application/pdf',
        ],
        { maxBuffer: 64 * 1024 * 1024 },
      );
      const extractMs = Date.now() - t0;
      const manifest = JSON.parse(stdout) as {
        units: { method?: string }[];
        chunks: unknown[];
        failures: unknown[];
        extractorVersion: string;
      };
      const ingested = await ingestExtraction(app, { ...ctx, fileId: upload.fileId, manifest });
      sourceOf.set(document.id, upload.sourceId);
      extraction.push({
        document: document.id,
        scanned: document.scanned,
        pages: document.pages.length,
        ocrUnits: manifest.units.filter((unit) => unit.method === 'ocr').length,
        chunks: manifest.chunks.length,
        failures: manifest.failures.length,
        status: ingested.status,
        extractor: manifest.extractorVersion,
        extractMs,
      });
    }

    return await fn({ corpus, app, admin, ctx, sourceOf, extraction });
  } finally {
    await Promise.allSettled([app.close(), admin.close(), auth.close()]);
    await database.stop();
  }
}
