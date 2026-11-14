import { eq } from 'drizzle-orm';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { z } from 'zod';

import type { Database } from '../../src/client';
import { createDatabase } from '../../src/client';
import { withSanadProject } from '../../src/sanad/access';
import { retrieve } from '../../src/sanad/retrieve';
import * as schema from '../../src/schema/index';
import { seedReferenceData } from '../../src/seed';

import type { WorkspaceFixture } from './fixtures';
import { seedWorkspace } from './fixtures';

const vector = (dimension: number) =>
  Array.from({ length: 1024 }, (_, i) => (i === dimension ? 1 : 0));

function only<T>(rows: T[]): T {
  const [row] = rows;
  if (row === undefined || rows.length !== 1) throw new Error('Expected exactly one fixture row.');
  return row;
}

describe('SANAD project retrieval and access using the real app role', () => {
  let database: Database;
  let admin: pg.Client;
  let a: WorkspaceFixture;
  let b: WorkspaceFixture;
  let otherProjectId: string;
  let lexicalId: string;
  let semanticId: string;
  let mismatchId: string;
  let abstractId: string;
  let otherProjectChunkId: string;

  beforeAll(async () => {
    admin = new pg.Client({ connectionString: inject('adminUrl') });
    await admin.connect();
    await seedReferenceData(admin);
    const plan = z
      .object({ id: z.string() })
      .parse((await admin.query("SELECT id FROM plans WHERE code = 'free'")).rows[0]);
    database = createDatabase({ connectionString: inject('appUrl') });
    a = await seedWorkspace(database, 'SANAD-A', plan.id);
    b = await seedWorkspace(database, 'SANAD-B', plan.id);
    await database.withWorkspace(a.workspaceId, async (tx) => {
      const entries = await tx
        .insert(schema.chunks)
        .values([
          {
            workspaceId: a.workspaceId,
            sourceId: a.sourceId,
            fileId: a.fileId,
            chunkIndex: 1,
            content: 'sanadneedle lexical passage',
            pageStart: 5,
            pageEnd: 5,
            embedding: vector(1),
            embeddingModel: 'sanad-model',
          },
          {
            workspaceId: a.workspaceId,
            sourceId: a.sourceId,
            fileId: a.fileId,
            chunkIndex: 2,
            content: 'Different scientific terminology',
            pageStart: 6,
            pageEnd: 6,
            embedding: vector(0),
            embeddingModel: 'sanad-model',
          },
          {
            workspaceId: a.workspaceId,
            sourceId: a.sourceId,
            fileId: a.fileId,
            chunkIndex: 3,
            content: 'Another model only',
            embedding: vector(0),
            embeddingModel: 'other-model',
          },
          {
            workspaceId: a.workspaceId,
            sourceId: a.sourceId,
            kind: 'abstract',
            chunkIndex: 4,
            content: 'sanadneedle abstract summary',
          },
        ])
        .returning({ id: schema.chunks.id, index: schema.chunks.chunkIndex });
      lexicalId = only(entries.filter((row) => row.index === 1)).id;
      semanticId = only(entries.filter((row) => row.index === 2)).id;
      mismatchId = only(entries.filter((row) => row.index === 3)).id;
      abstractId = only(entries.filter((row) => row.index === 4)).id;
      otherProjectId = only(
        await tx
          .insert(schema.projects)
          .values({ workspaceId: a.workspaceId, title: 'Other project' })
          .returning({ id: schema.projects.id }),
      ).id;
      const otherSource = only(
        await tx
          .insert(schema.sources)
          .values({
            workspaceId: a.workspaceId,
            origin: 'manual',
            type: 'article-journal',
            title: 'Other project source',
          })
          .returning({ id: schema.sources.id }),
      );
      await tx.insert(schema.projectSources).values({
        workspaceId: a.workspaceId,
        projectId: otherProjectId,
        sourceId: otherSource.id,
      });
      otherProjectChunkId = only(
        await tx
          .insert(schema.chunks)
          .values({
            workspaceId: a.workspaceId,
            sourceId: otherSource.id,
            chunkIndex: 0,
            content: 'sanadneedle other-project secret',
            embedding: vector(0),
            embeddingModel: 'sanad-model',
          })
          .returning({ id: schema.chunks.id }),
      ).id;
    });
    await database.withWorkspace(b.workspaceId, (tx) =>
      tx.insert(schema.chunks).values({
        workspaceId: b.workspaceId,
        sourceId: b.sourceId,
        fileId: b.fileId,
        chunkIndex: 1,
        content: 'sanadneedle other-user secret',
        embedding: vector(0),
        embeddingModel: 'sanad-model',
      }),
    );
  });

  afterAll(async () => {
    await database.close();
    await admin.end();
  });

  const context = () => ({ userId: a.userId, workspaceId: a.workspaceId, projectId: a.projectId });

  it('reports lexical mode and returns only matching source passages with stored provenance', async () => {
    const result = await retrieve(database, { ...context(), query: 'sanadneedle' });
    expect(result.mode).toBe('lexical');
    expect(result.results.map((row) => row.id).sort()).toEqual([lexicalId, abstractId].sort());
    expect(result.results.find((row) => row.id === lexicalId)).toMatchObject({
      chunkId: lexicalId,
      sourceId: a.sourceId,
      fileId: a.fileId,
      fileSha256: null,
      pageStart: 5,
      pageEnd: 5,
      verificationStatus: 'unverified',
      provenance: null,
      extraction: null,
    });
    expect(result.results.find((row) => row.id === abstractId)).toMatchObject({
      kind: 'abstract',
      pageStart: null,
      pageEnd: null,
      fileId: null,
      locator: null,
    });
  });

  it('combines lexical and semantic candidates without treating orthogonal vectors as matches', async () => {
    const result = await retrieve(database, {
      ...context(),
      query: 'sanadneedle',
      queryEmbedding: { model: 'sanad-model', values: vector(0) },
    });
    expect(result.mode).toBe('hybrid');
    expect(result.results.map((row) => row.id).sort()).toEqual(
      [lexicalId, abstractId, semanticId].sort(),
    );
    expect(result.results.find((row) => row.id === lexicalId)?.semanticRank).toBeNull();
    expect(result.results.find((row) => row.id === semanticId)).toMatchObject({
      semanticRank: 1,
      lexicalRank: null,
      pageStart: 6,
    });
    expect(result.results.some((row) => row.id === mismatchId)).toBe(false);
  });

  it('keeps vector model identities separate', async () => {
    const result = await retrieve(database, {
      ...context(),
      query: 'unmatchedterm',
      queryEmbedding: { model: 'other-model', values: vector(0) },
    });
    expect(result.results.map((row) => row.id)).toEqual([mismatchId]);
  });

  it('does not mix two projects in one workspace in either retrieval path', async () => {
    const input = {
      ...context(),
      query: 'sanadneedle',
      queryEmbedding: { model: 'sanad-model', values: vector(0) },
    };
    const own = await retrieve(database, input);
    expect(own.results.some((row) => row.id === otherProjectChunkId)).toBe(false);
    const other = await retrieve(database, { ...input, projectId: otherProjectId });
    expect(other.results.map((row) => row.id)).toEqual([otherProjectChunkId]);
  });

  it('refuses a real user entering another user workspace before querying research content', async () => {
    await expect(
      retrieve(database, {
        userId: a.userId,
        workspaceId: b.workspaceId,
        projectId: b.projectId,
        query: 'sanadneedle',
      }),
    ).rejects.toMatchObject({ code: 'SANAD_FORBIDDEN' });
  });

  it('does not reveal a project from another workspace or an unknown project', async () => {
    for (const projectId of [b.projectId, crypto.randomUUID()]) {
      await expect(
        retrieve(database, { ...context(), projectId, query: 'sanadneedle' }),
      ).rejects.toMatchObject({ code: 'SANAD_PROJECT_NOT_FOUND' });
    }
  });

  it('returns no evidence for unmatched lexical queries and binds SQL-like input as data', async () => {
    for (const query of ['unmatchedterm', "'); DROP TABLE chunks; --"]) {
      expect((await retrieve(database, { ...context(), query })).results).toEqual([]);
    }
    expect((await retrieve(database, { ...context(), query: 'sanadneedle' })).results).toHaveLength(
      2,
    );
  });

  it('uses existing Arabic normalization when retrieving Arabic text', async () => {
    const result = await retrieve(database, { ...context(), query: 'الإحصاء' });
    expect(result.results.map((row) => row.id)).toEqual([a.chunkId]);
    expect(result.results[0]?.pageStart).toBe(3);
  });

  it('keeps rankings stable and applies the validated result limit', async () => {
    const input = {
      ...context(),
      query: 'sanadneedle',
      limit: 1,
      queryEmbedding: { model: 'sanad-model', values: vector(0) },
    };
    const first = await retrieve(database, input);
    const second = await retrieve(database, input);
    expect(first).toEqual(second);
    expect(first.results).toHaveLength(1);
  });

  it('allows viewer reads but denies writes before invoking a callback', async () => {
    await database.withWorkspace(a.workspaceId, (tx) =>
      tx
        .update(schema.memberships)
        .set({ role: 'viewer' })
        .where(eq(schema.memberships.userId, a.userId)),
    );
    try {
      expect(
        (await retrieve(database, { ...context(), query: 'sanadneedle' })).results,
      ).toHaveLength(2);
      let called = false;
      await expect(
        withSanadProject(database, context(), true, () => {
          called = true;
          return Promise.resolve();
        }),
      ).rejects.toMatchObject({ code: 'SANAD_FORBIDDEN' });
      expect(called).toBe(false);
    } finally {
      await database.withWorkspace(a.workspaceId, (tx) =>
        tx
          .update(schema.memberships)
          .set({ role: 'owner' })
          .where(eq(schema.memberships.userId, a.userId)),
      );
    }
    await expect(
      withSanadProject(database, context(), true, () => Promise.resolve('authorized')),
    ).resolves.toBe('authorized');
  });
});
