import { afterAll, describe, expect, it } from 'vitest';

import { createDatabase } from '../../src/client';
import { withSanadProject } from '../../src/sanad/access';
import { rankSanadCandidates, RRF_OFFSET } from '../../src/sanad/ranking';
import { retrieve, sanadRetrieveSchema } from '../../src/sanad/retrieve';

const context = {
  userId: crypto.randomUUID(),
  workspaceId: crypto.randomUUID(),
  projectId: crypto.randomUUID(),
};
const vector = Array.from({ length: 1024 }, (_, i) => (i === 0 ? 1 : 0));

describe('SANAD retrieval validation', () => {
  it('normalizes query whitespace and defaults the result limit without inventing an embedding', () => {
    expect(sanadRetrieveSchema.parse({ ...context, query: '  الإحصاء  ' })).toEqual({
      ...context,
      query: 'الإحصاء',
      limit: 10,
    });
  });

  it.each([
    { query: '' },
    { query: '   ' },
    { query: 'a'.repeat(2001) },
    { limit: 0 },
    { limit: 51 },
    { limit: 1.5 },
    { workspaceId: 'invalid' },
    { queryEmbedding: { model: 'actual-model', values: [1, 2] } },
    { queryEmbedding: { model: '', values: vector } },
    { queryEmbedding: { model: 'actual-model', values: vector.map(() => 0) } },
    { queryEmbedding: { model: 'actual-model', values: vector.map(() => 1e-100) } },
    { queryEmbedding: { model: 'actual-model', values: [...vector.slice(0, -1), Infinity] } },
    { queryEmbedding: { model: 'actual-model', values: [...vector.slice(0, -1), NaN] } },
    { queryEmbedding: { model: 'actual-model', values: [...vector.slice(0, -1), 1e39] } },
  ])('rejects malformed input without querying providers: %j', (override) => {
    expect(
      sanadRetrieveSchema.safeParse({ ...context, query: 'research', ...override }).success,
    ).toBe(false);
  });

  it('accepts a finite nonzero 1024-dimensional vector with explicit model identity', () => {
    expect(
      sanadRetrieveSchema.safeParse({
        ...context,
        query: 'research',
        queryEmbedding: { model: 'actual-model', values: vector },
      }).success,
    ).toBe(true);
  });

  const database = createDatabase({ connectionString: 'postgresql://localhost/unused' });
  afterAll(async () => database.close());

  it('rejects bad context before opening a connection', async () => {
    await expect(
      withSanadProject(database, { ...context, userId: 'invalid' }, false, () =>
        Promise.resolve('unreachable'),
      ),
    ).rejects.toMatchObject({ code: 'SANAD_INVALID_INPUT' });
    expect(database.pool.totalCount).toBe(0);
  });

  it('retrieval reports a safe classified error instead of echoing input', async () => {
    await expect(
      retrieve(database, { ...context, query: 'private text', limit: -1 }),
    ).rejects.toMatchObject({
      code: 'SANAD_INVALID_INPUT',
      message: 'Invalid SANAD retrieval input.',
    });
    expect(database.pool.totalCount).toBe(0);
  });
});

describe('SANAD rank fusion', () => {
  it('fuses distinct lexical and semantic candidates and ranks shared evidence first', () => {
    const result = rankSanadCandidates(
      [
        { id: 'lexical', relevance: 0.7 },
        { id: 'shared', relevance: 0.4 },
      ],
      ['semantic', 'shared'],
    );
    expect(result.map((row) => row.id)).toEqual(['shared', 'lexical', 'semantic']);
    expect(result[0]).toMatchObject({
      lexicalRank: 2,
      semanticRank: 2,
      score: 2 / (RRF_OFFSET + 2),
    });
  });

  it('breaks equal RRF scores by lexical relevance, then stable id', () => {
    expect(
      rankSanadCandidates(
        [
          { id: 'b', relevance: 0 },
          { id: 'a', relevance: 0 },
        ],
        ['a', 'b'],
      ).map((row) => row.id),
    ).toEqual(['a', 'b']);
    expect(
      rankSanadCandidates(
        [
          { id: 'b', relevance: 0.8 },
          { id: 'a', relevance: 0.1 },
        ],
        ['a', 'b'],
      ).map((row) => row.id),
    ).toEqual(['b', 'a']);
  });

  it('does not count duplicated ids twice within a ranking list', () => {
    expect(
      rankSanadCandidates(
        [
          { id: 'a', relevance: 1 },
          { id: 'a', relevance: 2 },
        ],
        ['a', 'a'],
      ),
    ).toEqual([{ id: 'a', score: 2 / 61, lexicalRank: 1, semanticRank: 1, lexicalRelevance: 1 }]);
  });

  it('returns an empty ranking when neither path has evidence', () => {
    expect(rankSanadCandidates([], [])).toEqual([]);
  });
});
