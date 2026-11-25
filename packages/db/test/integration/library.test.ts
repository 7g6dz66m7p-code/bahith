import { createHash, randomUUID } from 'node:crypto';

import { eq } from 'drizzle-orm';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { z } from 'zod';

import type { Database } from '../../src/client';
import { createDatabase } from '../../src/client';
import {
  getProjectFile,
  listProjectLibrary,
  markFileFailed,
  markFileQueued,
  registerUpload,
} from '../../src/library';
import { ingestExtraction } from '../../src/sanad/ingest';
import * as schema from '../../src/schema/index';
import { seedReferenceData } from '../../src/seed';

import type { WorkspaceFixture } from './fixtures';
import { seedWorkspace } from './fixtures';

function upload(content: string, overrides: Record<string, unknown> = {}) {
  const fileId = randomUUID();
  return {
    fileId,
    originalName: 'منهج_البحث.txt',
    mimeType: 'text/plain',
    sizeBytes: Buffer.byteLength(content),
    sha256: createHash('sha256').update(content).digest('hex'),
    storageKey: `workspaces/test/files/${fileId}`,
    ...overrides,
  };
}

function manifestFor(content: string) {
  return {
    schemaVersion: 1,
    fileSha256: createHash('sha256').update(content).digest('hex'),
    mimeType: 'text/plain',
    extractorVersion: 'fixture-v1',
    chunkerVersion: 'fixture-v1',
    units: [{ index: 0, page: null, kind: 'text', content, direction: 'rtl' }],
    failures: [],
    chunks: [
      {
        index: 0,
        unitIndex: 0,
        charStart: 0,
        charEnd: Array.from(content).length,
        content,
        pageStart: null,
        pageEnd: null,
        tokenCount: 5,
        direction: 'rtl',
      },
    ],
  };
}

describe('research library', () => {
  let database: Database;
  let admin: pg.Client;
  let a: WorkspaceFixture;
  let b: WorkspaceFixture;
  const ctxA = () => ({ userId: a.userId, workspaceId: a.workspaceId, projectId: a.projectId });

  beforeAll(async () => {
    database = createDatabase({ connectionString: inject('appUrl') });
    admin = new pg.Client({ connectionString: inject('adminUrl') });
    await admin.connect();
    await seedReferenceData(admin);
    const plan = z
      .object({ id: z.string() })
      .parse((await admin.query(`SELECT id FROM plans WHERE code = 'free'`)).rows[0]);
    a = await seedWorkspace(database, 'LibraryA', plan.id);
    b = await seedWorkspace(database, 'LibraryB', plan.id);
  });

  afterAll(async () => {
    await database.close();
    await admin.end();
  });

  it('registers an upload as a new source attached to the project, with an audit entry', async () => {
    const input = upload('نص مصدر أول للاختبار');
    const result = await registerUpload(database, ctxA(), input);
    expect(result).toMatchObject({ fileId: input.fileId, duplicate: false, status: 'uploaded' });

    const library = await listProjectLibrary(database, ctxA());
    const entry = library.find((item) => item.sourceId === result.sourceId);
    expect(entry).toMatchObject({ title: 'منهج البحث', type: 'document', fullTextStatus: 'none' });
    expect(entry?.files).toEqual([
      expect.objectContaining({ id: input.fileId, status: 'uploaded', chunkCount: 0 }),
    ]);

    const audit = await admin.query(`SELECT action, metadata FROM audit_log WHERE entity_id = $1`, [
      input.fileId,
    ]);
    expect(audit.rows).toEqual([
      {
        action: 'source.uploaded',
        metadata: { mimeType: 'text/plain', sizeBytes: input.sizeBytes },
      },
    ]);
  });

  it('detects identical bytes and links the existing source instead of storing a copy', async () => {
    const first = await registerUpload(database, ctxA(), upload('محتوى مكرر'));
    const second = await registerUpload(database, ctxA(), upload('محتوى مكرر'));
    expect(second).toMatchObject({
      duplicate: true,
      fileId: first.fileId,
      sourceId: first.sourceId,
    });

    const count = await admin.query(`SELECT count(*)::int AS n FROM files WHERE sha256 = $1`, [
      createHash('sha256').update('محتوى مكرر').digest('hex'),
    ]);
    expect(count.rows).toEqual([{ n: 1 }]);
  });

  it('keeps exactly one file when identical uploads race', async () => {
    const content = `سباق ${randomUUID()}`;
    const results = await Promise.all(
      Array.from({ length: 5 }, () => registerUpload(database, ctxA(), upload(content))),
    );
    expect(new Set(results.map((result) => result.fileId)).size).toBe(1);
    expect(results.filter((result) => !result.duplicate)).toHaveLength(1);
  });

  it('the same bytes in another workspace are a separate file (no cross-tenant dedup)', async () => {
    const content = 'محتوى في فضاءين';
    const inA = await registerUpload(database, ctxA(), upload(content));
    const inB = await registerUpload(
      database,
      { userId: b.userId, workspaceId: b.workspaceId, projectId: b.projectId },
      upload(content),
    );
    expect(inB.duplicate).toBe(false);
    expect(inB.fileId).not.toBe(inA.fileId);
  });

  it('refuses another user, and refuses another workspace’s project', async () => {
    await expect(
      registerUpload(
        database,
        { userId: b.userId, workspaceId: a.workspaceId, projectId: a.projectId },
        upload('محاولة دخيلة'),
      ),
    ).rejects.toMatchObject({ code: 'SANAD_FORBIDDEN' });
    await expect(
      registerUpload(
        database,
        { userId: a.userId, workspaceId: a.workspaceId, projectId: b.projectId },
        upload('مشروع آخر'),
      ),
    ).rejects.toMatchObject({ code: 'SANAD_PROJECT_NOT_FOUND' });
    await expect(
      listProjectLibrary(database, {
        userId: b.userId,
        workspaceId: a.workspaceId,
        projectId: a.projectId,
      }),
    ).rejects.toMatchObject({ code: 'SANAD_FORBIDDEN' });
  });

  it('a viewer can read the library but cannot upload', async () => {
    await admin.query(
      `INSERT INTO memberships (workspace_id, user_id, role) VALUES ($1, $2, 'viewer')`,
      [a.workspaceId, b.userId],
    );
    try {
      const asViewer = { userId: b.userId, workspaceId: a.workspaceId, projectId: a.projectId };
      expect(Array.isArray(await listProjectLibrary(database, asViewer))).toBe(true);
      await expect(registerUpload(database, asViewer, upload('مطّلع'))).rejects.toMatchObject({
        code: 'SANAD_FORBIDDEN',
      });
    } finally {
      await admin.query(`DELETE FROM memberships WHERE workspace_id = $1 AND user_id = $2`, [
        a.workspaceId,
        b.userId,
      ]);
    }
  });

  it.each([
    ['an unsupported type', { mimeType: 'application/zip' }],
    ['a file over 50 MB', { sizeBytes: 50 * 1024 * 1024 + 1 }],
    ['a bad digest', { sha256: 'abc' }],
    ['an empty name', { originalName: '  ' }],
    ['an unknown field', { userId: randomUUID() }],
  ])('rejects %s', async (_name, overrides) => {
    await expect(
      registerUpload(database, ctxA(), upload(`x${randomUUID()}`, overrides)),
    ).rejects.toMatchObject({ code: 'SANAD_INVALID_INPUT' });
  });

  it('moves a file through processing to ready via ingestion', async () => {
    const content = 'تعتمد الدراسة على تحليل المصادر الأصلية';
    const input = upload(content);
    await registerUpload(database, ctxA(), input);
    await markFileQueued(database, ctxA(), input.fileId);
    expect((await getProjectFile(database, ctxA(), input.fileId)).status).toBe('processing');

    await ingestExtraction(database, {
      ...ctxA(),
      fileId: input.fileId,
      manifest: manifestFor(content),
    });
    const entry = (await listProjectLibrary(database, ctxA())).find((item) =>
      item.files.some((file) => file.id === input.fileId),
    );
    expect(entry?.fullTextStatus).toBe('full_text');
    expect(entry?.files[0]).toMatchObject({ status: 'ready', chunkCount: 1, ocrUsed: false });
  });

  it('records a failure with a stable code only', async () => {
    const input = upload(`فشل ${randomUUID()}`);
    await registerUpload(database, ctxA(), input);
    await markFileQueued(database, ctxA(), input.fileId);
    await markFileFailed(database, ctxA(), input.fileId, 'INVALID_DOCUMENT');
    const file = await getProjectFile(database, ctxA(), input.fileId);
    expect(file.status).toBe('failed');
    const [row] = await database.withWorkspace(a.workspaceId, (tx) =>
      tx
        .select({ errorCode: schema.files.errorCode })
        .from(schema.files)
        .where(eq(schema.files.id, input.fileId)),
    );
    expect(row?.errorCode).toBe('INVALID_DOCUMENT');
    await expect(
      markFileFailed(database, ctxA(), input.fileId, 'free text with <script>'),
    ).rejects.toMatchObject({ code: 'SANAD_INVALID_INPUT' });
  });

  it('only serves a file through a project it is attached to', async () => {
    const input = upload(`ملف ${randomUUID()}`);
    await registerUpload(database, ctxA(), input);
    expect((await getProjectFile(database, ctxA(), input.fileId)).storageKey).toBe(
      input.storageKey,
    );
    await expect(
      getProjectFile(
        database,
        { userId: b.userId, workspaceId: b.workspaceId, projectId: b.projectId },
        input.fileId,
      ),
    ).rejects.toMatchObject({ code: 'SANAD_FILE_NOT_FOUND' });
  });
});
