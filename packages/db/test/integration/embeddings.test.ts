import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { z } from 'zod';

import type { Database } from '../../src/index';
import {
  AssistantError,
  countEmbeddedChunks,
  createDatabase,
  listChunksToEmbed,
  retrieve,
  setProjectAiConsent,
  storeChunkEmbeddings,
} from '../../src/index';
import { seedReferenceData } from '../../src/seed';

import type { WorkspaceFixture } from './fixtures';
import { embeddingOf, seedWorkspace } from './fixtures';

// Deterministic test vectors (embeddingOf) stand in for provider output: tests only.
describe('embeddings: consent-gated listing, storage and semantic retrieval', () => {
  let database: Database;
  let a: WorkspaceFixture;
  let b: WorkspaceFixture;
  const ctx = () => ({ userId: a.userId, workspaceId: a.workspaceId, projectId: a.projectId });

  beforeAll(async () => {
    database = createDatabase({ connectionString: inject('appUrl') });
    const admin = new pg.Client({ connectionString: inject('adminUrl') });
    await admin.connect();
    await seedReferenceData(admin);
    const plan = z
      .object({ id: z.string() })
      .parse((await admin.query(`SELECT id FROM plans WHERE code = 'free'`)).rows[0]);
    await admin.end();
    a = await seedWorkspace(database, 'EmbedA', plan.id);
    b = await seedWorkspace(database, 'EmbedB', plan.id);
  });

  afterAll(async () => {
    await database.close();
  });

  it('nothing is listed for the provider without the project’s consent', async () => {
    await expect(listChunksToEmbed(database, ctx(), 'test-model', 10)).rejects.toEqual(
      new AssistantError('AI_CONSENT_REQUIRED'),
    );
  });

  it('lists passages missing a vector for the model, stores them, and retrieves semantically', async () => {
    await setProjectAiConsent(database, ctx(), true);
    const pending = await listChunksToEmbed(database, ctx(), 'test-model', 50);
    expect(pending.length).toBeGreaterThan(0);
    const before = await countEmbeddedChunks(database, ctx(), 'test-model');
    await storeChunkEmbeddings(database, ctx(), {
      model: 'test-model',
      items: pending.map((item, index) => ({
        chunkId: item.chunkId,
        vector: embeddingOf(index + 7),
      })),
    });
    expect(await countEmbeddedChunks(database, ctx(), 'test-model')).toBe(before + pending.length);
    expect(await listChunksToEmbed(database, ctx(), 'test-model', 50)).toEqual([]);
    // A different model needs its own vectors.
    expect((await listChunksToEmbed(database, ctx(), 'other-model', 50)).length).toBe(
      pending.length,
    );

    const first = pending[0];
    const result = await retrieve(database, {
      ...ctx(),
      query: 'zzzz-no-lexical-match',
      queryEmbedding: { model: 'test-model', values: embeddingOf(7) },
    });
    expect(result.mode).toBe('hybrid');
    expect(result.results.map((row) => row.chunkId)).toContain(first?.chunkId);
  });

  it('refuses invalid vectors and passages outside the project', async () => {
    const [own] = await listChunksToEmbed(database, ctx(), 'third-model', 1);
    await expect(
      storeChunkEmbeddings(database, ctx(), {
        model: 'third-model',
        items: [{ chunkId: own?.chunkId ?? '', vector: [1, 2, 3] }],
      }),
    ).rejects.toMatchObject({ code: 'SANAD_INVALID_INPUT' });
    await expect(
      storeChunkEmbeddings(database, ctx(), {
        model: 'third-model',
        items: [{ chunkId: b.chunkId, vector: embeddingOf(3) }],
      }),
    ).rejects.toMatchObject({ code: 'SANAD_SOURCE_MISMATCH' });
    const intruder = { userId: b.userId, workspaceId: a.workspaceId, projectId: a.projectId };
    await expect(listChunksToEmbed(database, intruder, 'test-model', 5)).rejects.toMatchObject({
      code: 'SANAD_FORBIDDEN',
    });
  });
});
