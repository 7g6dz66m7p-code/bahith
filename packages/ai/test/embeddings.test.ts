import { MockEmbeddingModelV4 } from 'ai/test';
import { describe, expect, it } from 'vitest';

import {
  AiCallError,
  AiConfigError,
  AiProviderError,
  EMBEDDING_DIMENSIONS,
  embedTexts,
  loadEmbeddingModelRef,
  resolveEmbeddingModel,
} from '../src/index';

// Test doubles only: deterministic vectors, never presented as real embeddings.
const vector = (seed: number, size = EMBEDDING_DIMENSIONS) =>
  Array.from({ length: size }, (_, i) => Math.sin(seed * (i + 1)));

function mockModel(size = EMBEDDING_DIMENSIONS, calls: unknown[] = []) {
  return new MockEmbeddingModelV4({
    maxEmbeddingsPerCall: 100,
    doEmbed: (options) => {
      calls.push(options);
      return Promise.resolve({
        embeddings: options.values.map((_, index) => vector(index + 1, size)),
        usage: { tokens: 10 },
        warnings: [],
      });
    },
  });
}

describe('embeddings', () => {
  it('requests exactly 1024 dimensions and returns one vector per text', async () => {
    const calls: unknown[] = [];
    const batch = await embedTexts({
      model: mockModel(EMBEDDING_DIMENSIONS, calls),
      modelId: 'test-embedding',
      values: ['مقطع أول', 'second passage'],
    });
    expect(batch.vectors).toHaveLength(2);
    expect(batch.vectors[0]).toHaveLength(EMBEDDING_DIMENSIONS);
    expect(JSON.stringify(calls[0])).toContain('"dimensions":1024');
  });

  it('refuses vectors of the wrong size instead of padding or truncating them', async () => {
    await expect(
      embedTexts({ model: mockModel(1536), modelId: 'm', values: ['x'] }),
    ).rejects.toEqual(new AiCallError('AI_OUTPUT_INVALID'));
  });

  it('is off unless configured, and only providers with 1024-dimension embeddings are accepted', () => {
    expect(loadEmbeddingModelRef({})).toBeNull();
    expect(loadEmbeddingModelRef({ AI_EMBEDDING_MODEL: 'openai:text-embedding-3-small' })).toEqual({
      provider: 'openai',
      model: 'text-embedding-3-small',
    });
    expect(() => loadEmbeddingModelRef({ AI_EMBEDDING_MODEL: 'no-colon' })).toThrow(AiConfigError);
    expect(() => resolveEmbeddingModel({ provider: 'anthropic', model: 'x' }, {})).toThrow(
      AiProviderError,
    );
    expect(() => resolveEmbeddingModel({ provider: 'openai', model: 'x' }, {})).toThrow(
      new AiProviderError('AI_PROVIDER_KEY_MISSING', 'openai', 'OPENAI_API_KEY'),
    );
  });
});
