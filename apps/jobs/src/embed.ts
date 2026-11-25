import {
  AiCallError,
  EMBEDDING_BATCH_SIZE,
  embedTexts,
  loadEmbeddingModelRef,
  resolveEmbeddingModel,
} from '@bahith/ai';
import type { Database } from '@bahith/db';
import {
  AssistantError,
  finishAssistantRun,
  listChunksToEmbed,
  startAssistantRun,
  storeChunkEmbeddings,
} from '@bahith/db';
import { embedJobSchema } from '@bahith/pipeline';
import { UnrecoverableError } from 'bullmq';

import { errorCode, log } from './log';

/** The configured embedding model; `embed` sends texts to it (real provider in production). */
export interface Embedder {
  provider: string;
  model: string;
  embed(values: readonly string[]): Promise<{ vectors: number[][]; tokens: number | null }>;
}

export type EmbedOutcome =
  { status: 'done'; embedded: number } | { status: 'skipped'; code: string };

/** Batches per job run; a large project continues in the next run. */
const MAX_BATCHES = 20;

/**
 * Embeds a project's passages that lack a vector for the configured model. Every batch
 * is one model request through the same gate as the assistant: project consent, then
 * the plan quota, then an agent run with metadata only. Without a configured model,
 * consent or quota the job ends without calling any provider.
 */
export function createEmbedHandler(deps: { database: Database; embedder: Embedder | null }) {
  return async (data: unknown): Promise<EmbedOutcome> => {
    const parsed = embedJobSchema.safeParse(data);
    if (!parsed.success) throw new UnrecoverableError('PIPELINE_INVALID_PAYLOAD');
    const context = parsed.data;
    const { database, embedder } = deps;
    if (embedder === null) return { status: 'skipped', code: 'AI_EMBEDDING_NOT_CONFIGURED' };
    let embedded = 0;
    for (let batch = 0; batch < MAX_BATCHES; batch += 1) {
      let pending: { chunkId: string; content: string }[];
      let runId: string;
      try {
        pending = await listChunksToEmbed(database, context, embedder.model, EMBEDDING_BATCH_SIZE);
        if (pending.length === 0) break;
        ({ runId } = await startAssistantRun(database, context, {
          agent: 'embedder',
          promptVersion: 'embed@1',
          provider: embedder.provider,
          model: embedder.model,
        }));
      } catch (error) {
        if (error instanceof AssistantError) {
          log.info('sanad.embed_skipped', { projectId: context.projectId, code: error.code });
          return { status: 'skipped', code: error.code };
        }
        throw error;
      }
      const started = Date.now();
      try {
        const result = await embedder.embed(pending.map((item) => item.content));
        await storeChunkEmbeddings(database, context, {
          model: embedder.model,
          items: pending.map((item, index) => ({
            chunkId: item.chunkId,
            vector: result.vectors[index] ?? [],
          })),
        });
        await finishAssistantRun(database, context, runId, {
          status: 'succeeded',
          inputTokens: result.tokens,
          outputTokens: 0,
          latencyMs: Date.now() - started,
          errorCode: null,
        });
        embedded += pending.length;
      } catch (error) {
        const code = error instanceof AiCallError ? error.code : 'EMBEDDING_FAILED';
        await finishAssistantRun(database, context, runId, {
          status: 'failed',
          inputTokens: null,
          outputTokens: null,
          latencyMs: Date.now() - started,
          errorCode: code,
        });
        log.warn('sanad.embed_failed', {
          projectId: context.projectId,
          code,
          error: errorCode(error),
        });
        // No balance or a bad key will not fix itself on retry.
        if (code === 'AI_PROVIDER_QUOTA' || code === 'AI_PROVIDER_AUTH') {
          throw new UnrecoverableError(code);
        }
        throw error;
      }
    }
    log.info('sanad.embedded', { projectId: context.projectId, embedded });
    return { status: 'done', embedded };
  };
}

/** The real embedder from AI_EMBEDDING_MODEL and the provider key, or null when unset. */
export function embedderFromEnv(env: Record<string, string | undefined>): Embedder | null {
  const ref = loadEmbeddingModelRef(env);
  if (ref === null) return null;
  const model = resolveEmbeddingModel(ref, env);
  return {
    provider: ref.provider,
    model: ref.model,
    embed: async (values) => {
      const batch = await embedTexts({ model, modelId: ref.model, values });
      return { vectors: batch.vectors, tokens: batch.tokens };
    },
  };
}
