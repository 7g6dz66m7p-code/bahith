import { createOpenAI } from '@ai-sdk/openai';
import { embedMany } from 'ai';
import type { EmbeddingModel } from 'ai';

import { AiCallError, classifyAiError } from './agents/grounded-answer';
import { AiConfigError } from './config';
import type { ModelRef } from './config';
import { AiProviderError, PROVIDER_KEY_VARIABLES } from './providers';

/** Must equal the vector(1024) column of chunks.embedding (ADR-0002, ADR-0005). */
export const EMBEDDING_DIMENSIONS = 1024;
/** Passages per provider request (one request counts once against the plan quota). */
export const EMBEDDING_BATCH_SIZE = 64;

/** AI_EMBEDDING_MODEL as provider:model, or null when it is not set (lexical-only search). */
export function loadEmbeddingModelRef(env: Record<string, string | undefined>): ModelRef | null {
  const value = env.AI_EMBEDDING_MODEL?.trim();
  if (value === undefined || value === '') return null;
  const match = /^([a-z0-9][a-z0-9-]*):(\S+)$/u.exec(value);
  if (match === null) throw new AiConfigError(['AI_EMBEDDING_MODEL']);
  return { provider: match[1] ?? '', model: match[2] ?? '' };
}

export function resolveEmbeddingModel(
  ref: ModelRef,
  env: Record<string, string | undefined>,
): EmbeddingModel {
  // Only providers whose embeddings can be requested at exactly 1024 dimensions.
  if (ref.provider !== 'openai') throw new AiProviderError('AI_PROVIDER_UNSUPPORTED', ref.provider);
  const variable = PROVIDER_KEY_VARIABLES.openai;
  const apiKey = env[variable]?.trim();
  if (apiKey === undefined || apiKey === '') {
    throw new AiProviderError('AI_PROVIDER_KEY_MISSING', ref.provider, variable);
  }
  return createOpenAI({ apiKey }).embedding(ref.model);
}

export interface EmbeddingBatch {
  model: string;
  vectors: number[][];
  tokens: number;
}

/**
 * Embeds texts with the configured model. Every vector must have exactly 1024
 * dimensions and not be all zeros; otherwise nothing is returned (no padding,
 * truncation or made-up vectors).
 */
export async function embedTexts(input: {
  model: EmbeddingModel;
  modelId: string;
  values: readonly string[];
  timeoutMs?: number;
}): Promise<EmbeddingBatch> {
  if (input.values.length === 0) return { model: input.modelId, vectors: [], tokens: 0 };
  if (input.values.length > EMBEDDING_BATCH_SIZE) throw new AiCallError('AI_OUTPUT_INVALID');
  try {
    const result = await embedMany({
      model: input.model,
      values: [...input.values],
      dimensions: EMBEDDING_DIMENSIONS,
      maxRetries: 2,
      abortSignal: AbortSignal.timeout(input.timeoutMs ?? 60_000),
    });
    const valid =
      result.embeddings.length === input.values.length &&
      result.embeddings.every(
        (vector) =>
          vector.length === EMBEDDING_DIMENSIONS &&
          vector.every((value) => Number.isFinite(value)) &&
          vector.some((value) => value !== 0),
      );
    if (!valid) throw new AiCallError('AI_OUTPUT_INVALID');
    return {
      model: input.modelId,
      vectors: result.embeddings.map((vector) => [...vector]),
      tokens: result.usage.tokens,
    };
  } catch (error) {
    throw classifyAiError(error);
  }
}
