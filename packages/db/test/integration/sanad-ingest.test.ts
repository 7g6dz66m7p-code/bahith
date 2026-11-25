import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { and, eq } from 'drizzle-orm';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { z } from 'zod';

import { verifyQuotation } from '../../../ai/src/sanad/verify';
import type { Database } from '../../src/client';
import { createDatabase } from '../../src/client';
import { ingestExtraction } from '../../src/sanad/ingest';
import { retrieve } from '../../src/sanad/retrieve';
import * as schema from '../../src/schema/index';
import { seedReferenceData } from '../../src/seed';

import type { WorkspaceFixture } from './fixtures';
import { seedWorkspace } from './fixtures';

const exec = promisify(execFile);

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

describe('SANAD ingestion and source version preservation', () => {
  let database: Database;
  let admin: pg.Client;
  let a: WorkspaceFixture;
  let b: WorkspaceFixture;

  beforeAll(async () => {
    database = createDatabase({ connectionString: inject('appUrl') });
    admin = new pg.Client({ connectionString: inject('adminUrl') });
    await admin.connect();
    await seedReferenceData(admin);
    const plan = z
      .object({ id: z.string() })
      .parse((await admin.query(`SELECT id FROM plans WHERE code = 'free'`)).rows[0]);
    a = await seedWorkspace(database, 'IngestA', plan.id);
    b = await seedWorkspace(database, 'IngestB', plan.id);
  });

  afterAll(async () => {
    await database.close();
    await admin.end();
  });

  const context = () => ({ userId: a.userId, workspaceId: a.workspaceId, projectId: a.projectId });
  async function registerFile(mimeType = 'text/plain', sha256: string | null = null) {
    const [row] = await database.withWorkspace(a.workspaceId, (tx) =>
      tx
        .insert(schema.files)
        .values({
          workspaceId: a.workspaceId,
          sourceId: a.sourceId,
          storageKey: `${a.workspaceId}/${crypto.randomUUID()}`,
          originalName: 'fixture',
          mimeType,
          sizeBytes: 100,
          sha256,
        })
        .returning({ id: schema.files.id }),
    );
    if (row === undefined) throw new Error('fixture file missing');
    return row.id;
  }

  it('persists genuine offsets and hashes atomically; replay returns the same chunk ids', async () => {
    const manifest = manifestFor('وثيقة اختبار 🧪 علمي');
    const fileId = await registerFile();
    const input = { ...context(), fileId, manifest };
    const result = await ingestExtraction(database, input);
    expect(result).toMatchObject({ status: 'ready', reused: false, failures: [] });
    expect(result.chunkIds).toHaveLength(1);
    expect(await ingestExtraction(database, input)).toEqual({ ...result, reused: true });
    const [stored] = await database.withWorkspace(a.workspaceId, (tx) =>
      tx
        .select()
        .from(schema.chunks)
        .where(eq(schema.chunks.id, result.chunkIds[0] ?? '')),
    );
    expect(stored).toMatchObject({
      content: manifest.chunks[0]?.content,
      pageStart: null,
      provenance: {
        charStart: 0,
        charEnd: Array.from(manifest.units[0]?.content ?? '').length,
        fileSha256: manifest.fileSha256,
        unitKind: 'text',
      },
    });
  });

  it('rejects replacement bytes and preserves the existing source version', async () => {
    const fileId = await registerFile();
    await ingestExtraction(database, { ...context(), fileId, manifest: manifestFor('original') });
    await expect(
      ingestExtraction(database, { ...context(), fileId, manifest: manifestFor('replacement') }),
    ).rejects.toMatchObject({ code: 'SANAD_VERSION_CONFLICT' });
    await expect(
      database.withWorkspace(a.workspaceId, (tx) =>
        tx
          .update(schema.files)
          .set({ sha256: 'b'.repeat(64) })
          .where(eq(schema.files.id, fileId)),
      ),
    ).rejects.toMatchObject({ cause: { code: '23514' } });
    await expect(
      database.withWorkspace(a.workspaceId, (tx) =>
        tx
          .update(schema.chunks)
          .set({ content: 'changed' })
          .where(eq(schema.chunks.fileId, fileId)),
      ),
    ).rejects.toMatchObject({ cause: { code: '23514' } });
  });

  it('guards the published passage set against direct additions and deletions', async () => {
    const fileId = await registerFile();
    await ingestExtraction(database, {
      ...context(),
      fileId,
      manifest: manifestFor('immutable set'),
    });
    await expect(
      database.withWorkspace(a.workspaceId, (tx) =>
        tx.delete(schema.chunks).where(eq(schema.chunks.fileId, fileId)),
      ),
    ).rejects.toMatchObject({ cause: { code: '23514' } });
    await expect(
      database.withWorkspace(a.workspaceId, (tx) =>
        tx.insert(schema.chunks).values({
          workspaceId: a.workspaceId,
          sourceId: a.sourceId,
          fileId,
          chunkIndex: 1,
          content: 'injected',
        }),
      ),
    ).rejects.toMatchObject({ cause: { code: '23514' } });
  });

  it('still allows deleting a file and cascading its uncited passages', async () => {
    const fileId = await registerFile();
    await ingestExtraction(database, {
      ...context(),
      fileId,
      manifest: manifestFor('delete fixture'),
    });
    await database.withWorkspace(a.workspaceId, (tx) =>
      tx.delete(schema.files).where(eq(schema.files.id, fileId)),
    );
    expect(
      await database.withWorkspace(a.workspaceId, (tx) =>
        tx.select().from(schema.chunks).where(eq(schema.chunks.fileId, fileId)),
      ),
    ).toEqual([]);
  });

  it('requires the registered byte hash and does not publish partial writes', async () => {
    const fileId = await registerFile('text/plain', 'b'.repeat(64));
    await expect(
      ingestExtraction(database, { ...context(), fileId, manifest: manifestFor('hash mismatch') }),
    ).rejects.toMatchObject({ code: 'SANAD_VERSION_CONFLICT' });
    const rows = await database.withWorkspace(a.workspaceId, (tx) =>
      tx.select().from(schema.chunks).where(eq(schema.chunks.fileId, fileId)),
    );
    expect(rows).toEqual([]);
  });

  it('persists supplied model-specific vectors and retrieves semantic-only candidates', async () => {
    const fileId = await registerFile();
    // Deliberately artificial test vector; never used as a research result or embedding provider.
    const vector = Array.from({ length: schema.EMBEDDING_DIMENSIONS }, (_, index) =>
      index === 0 ? 1 : 0,
    );
    await ingestExtraction(database, {
      ...context(),
      fileId,
      manifest: manifestFor('embedding pipeline test fixture'),
      embeddings: { model: 'fixture-vector-model', vectors: [vector] },
    });
    const found = await retrieve(database, {
      ...context(),
      query: 'unmatchedterm',
      queryEmbedding: { model: 'fixture-vector-model', values: vector },
    });
    expect(found.mode).toBe('hybrid');
    expect(found.results.map((row) => row.fileId)).toEqual([fileId]);
    expect(found.results[0]?.lexicalRank).toBeNull();
  });

  it.each(['wrong-dimension', 'zero', 'underflow', 'wrong-count'])(
    'rejects an invalid embedding batch without publishing chunks: %s',
    async (reason) => {
      const fileId = await registerFile();
      const vector = Array.from({ length: schema.EMBEDDING_DIMENSIONS }, () =>
        reason === 'underflow' ? 1e-100 : 0,
      );
      const vectors = reason === 'wrong-count' ? [] : [reason === 'wrong-dimension' ? [1] : vector];
      await expect(
        ingestExtraction(database, {
          ...context(),
          fileId,
          manifest: manifestFor('invalid vector fixture'),
          embeddings: { model: 'fixture', vectors },
        }),
      ).rejects.toMatchObject({ code: 'SANAD_INVALID_INPUT' });
      const [file] = await database.withWorkspace(a.workspaceId, (tx) =>
        tx.select().from(schema.files).where(eq(schema.files.id, fileId)),
      );
      expect(file?.extraction).toBeNull();
    },
  );

  it('denies another user even when given valid project and file ids', async () => {
    const fileId = await registerFile();
    await expect(
      ingestExtraction(database, {
        ...context(),
        userId: b.userId,
        fileId,
        manifest: manifestFor('private'),
      }),
    ).rejects.toMatchObject({ code: 'SANAD_FORBIDDEN' });
  });

  it('denies a source outside the selected project within the same workspace', async () => {
    const projectId = crypto.randomUUID();
    await database.withWorkspace(a.workspaceId, (tx) =>
      tx
        .insert(schema.projects)
        .values({ id: projectId, workspaceId: a.workspaceId, title: 'Other project' }),
    );
    const fileId = await registerFile();
    await expect(
      ingestExtraction(database, {
        ...context(),
        projectId,
        fileId,
        manifest: manifestFor('private'),
      }),
    ).rejects.toMatchObject({ code: 'SANAD_SOURCE_MISMATCH' });
  });

  it('keeps readable PDF pages and explicit failed-page diagnostics without invented text', async () => {
    const original = manifestFor('real extracted fixture text');
    const fileId = await registerFile('application/pdf');
    const result = await ingestExtraction(database, {
      ...context(),
      fileId,
      manifest: {
        ...original,
        mimeType: 'application/pdf',
        units: [
          { ...original.units[0], kind: 'page', page: 1 },
          { index: 1, page: 2, kind: 'page', content: '', direction: 'auto' },
        ],
        chunks: [{ ...original.chunks[0], pageStart: 1, pageEnd: 1 }],
        failures: [{ unitIndex: 1, page: 2, code: 'PDF_PAGE_FAILED' }],
      },
    });
    expect(result).toMatchObject({
      status: 'ready',
      failures: [{ page: 2, code: 'PDF_PAGE_FAILED' }],
    });
    const [file] = await database.withWorkspace(a.workspaceId, (tx) =>
      tx.select().from(schema.files).where(eq(schema.files.id, fileId)),
    );
    expect(file).toMatchObject({ pageCount: 2, extraction: { chunkCount: 1 } });
  });

  it('stores an empty extraction as failed and produces no citable passages', async () => {
    const fileId = await registerFile();
    const result = await ingestExtraction(database, {
      ...context(),
      fileId,
      manifest: { ...manifestFor(''), chunks: [] },
    });
    expect(result).toMatchObject({ status: 'failed', chunkIds: [] });
    const [file] = await database.withWorkspace(a.workspaceId, (tx) =>
      tx.select().from(schema.files).where(eq(schema.files.id, fileId)),
    );
    expect(file?.errorCode).toBe('SANAD_NO_TEXT');
  });

  it.each([
    { format: 'TXT', extension: 'txt', mimeType: 'text/plain', page: null, quote: 'وثيقة اختبار' },
    {
      format: 'DOCX',
      extension: 'docx',
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      page: null,
      quote: 'وثيقة اختبار',
    },
    {
      format: 'PDF',
      extension: 'pdf',
      mimeType: 'application/pdf',
      page: 1,
      quote: 'interoperation fixture',
    },
  ])(
    '$format: real Python extraction → validated DB ingestion → retrieval → quotation binding',
    async ({ extension, mimeType, page, quote }) => {
      const temp = await mkdtemp(path.join(tmpdir(), 'sanad-flow-'));
      // These documents are local software-test fixtures, never scientific evidence.
      const content =
        extension === 'pdf'
          ? 'SANAD interoperation fixture. Software test document.'
          : 'هذه وثيقة اختبار للمسار البرمجي. SANAD interoperation fixture.';
      try {
        const source = path.join(temp, `source.${extension}`);
        const output = path.join(temp, 'manifest.json');
        const worker = fileURLToPath(new URL('../../../../apps/worker/', import.meta.url));
        if (extension === 'txt') {
          await writeFile(source, content, 'utf8');
        } else {
          const generator =
            extension === 'docx'
              ? [
                  'import sys',
                  'from docx import Document',
                  'document = Document()',
                  'document.add_paragraph(sys.argv[2])',
                  'document.add_table(rows=1, cols=1).cell(0, 0).text = "خلية اختبار للمستند"',
                  'document.save(sys.argv[1])',
                ].join('\n')
              : [
                  'import sys',
                  'from pypdf import PdfWriter',
                  'from pypdf.generic import DecodedStreamObject, DictionaryObject, NameObject',
                  'writer = PdfWriter()',
                  'page = writer.add_blank_page(width=300, height=300)',
                  'font = DictionaryObject({NameObject("/Type"): NameObject("/Font"),',
                  '    NameObject("/Subtype"): NameObject("/Type1"),',
                  '    NameObject("/BaseFont"): NameObject("/Helvetica")})',
                  'page[NameObject("/Resources")] = DictionaryObject({NameObject("/Font"):',
                  '    DictionaryObject({NameObject("/F1"): writer._add_object(font)})})',
                  'stream = DecodedStreamObject()',
                  'stream.set_data(("BT /F1 12 Tf 20 20 Td (" + sys.argv[2] + ") Tj ET").encode("ascii"))',
                  'page[NameObject("/Contents")] = writer._add_object(stream)',
                  'with open(sys.argv[1], "wb") as output:',
                  '    writer.write(output)',
                ].join('\n');
          const generated = await exec('uv', ['run', 'python', '-c', generator, source, content], {
            cwd: worker,
          });
          expect(generated.stdout + generated.stderr).not.toContain(content);
        }
        const bytes = await readFile(source);
        const fileSha256 = createHash('sha256').update(bytes).digest('hex');
        const { stdout, stderr } = await exec(
          'uv',
          [
            'run',
            'python',
            '-m',
            'bahith_worker.sanad',
            source,
            '--mime-type',
            mimeType,
            '--output',
            output,
          ],
          { cwd: worker },
        );
        expect(stdout + stderr).not.toContain(content);
        expect(stdout + stderr).not.toContain(quote);
        const manifest: unknown = JSON.parse(await readFile(output, 'utf8'));
        const fileId = await registerFile(mimeType, fileSha256);
        await database.withWorkspace(a.workspaceId, (tx) =>
          tx
            .update(schema.files)
            .set({ sizeBytes: bytes.length })
            .where(eq(schema.files.id, fileId)),
        );
        const ingested = await ingestExtraction(database, { ...context(), fileId, manifest });
        const response = await retrieve(database, { ...context(), query: 'interoperation' });
        const evidence = response.results.find((row) => row.fileId === fileId);
        expect(evidence?.chunkId).toBe(ingested.chunkIds[0]);
        if (evidence === undefined) throw new Error('fixture evidence missing');
        const match = verifyQuotation({ chunkId: evidence.chunkId, quote }, [
          {
            chunkId: evidence.chunkId,
            sourceId: evidence.sourceId,
            content: evidence.content,
            kind: evidence.kind,
            fileId: evidence.fileId,
            fileSha256: evidence.fileSha256,
            pageStart: evidence.pageStart,
            pageEnd: evidence.pageEnd,
            sourceVerificationStatus: evidence.verificationStatus,
          },
        ]);
        expect(match).toMatchObject({
          status: 'exact_quote_match',
          reviewStatus: 'needs_human_review',
          pageStart: page,
          pageEnd: page,
          fileId,
          fileSha256,
        });
        const stored = await database.withWorkspace(a.workspaceId, (tx) =>
          tx
            .select()
            .from(schema.chunks)
            .where(
              and(eq(schema.chunks.fileId, fileId), eq(schema.chunks.workspaceId, a.workspaceId)),
            ),
        );
        expect(stored).toHaveLength(extension === 'docx' ? 2 : 1);
        expect(stored.every((chunk) => chunk.pageStart === page && chunk.pageEnd === page)).toBe(
          true,
        );
        expect(stored.every((chunk) => chunk.provenance?.fileSha256 === fileSha256)).toBe(true);
      } finally {
        await rm(temp, { recursive: true, force: true });
      }
    },
  );
});
