import type { LanguageModel } from 'ai';

import { AiCallError } from './agents/grounded-answer';
import { AiConfigError } from './config';
import type { ModelRef } from './config';
import { AiProviderError, loadChatModelRef, resolveLanguageModel } from './providers';

/**
 * Chat model chain: AI_CHAT_MODEL, then the optional AI_CHAT_FALLBACK_MODEL (another
 * provider). Model names stay configuration; nothing here picks a model by itself.
 */
export function loadChatModelChain(env: Record<string, string | undefined>): ModelRef[] {
  const primary = loadChatModelRef(env);
  const raw = env.AI_CHAT_FALLBACK_MODEL?.trim() ?? '';
  if (raw === '') return [primary];
  let fallback: ModelRef;
  try {
    fallback = loadChatModelRef({ AI_CHAT_MODEL: raw });
  } catch {
    throw new AiConfigError(['AI_CHAT_FALLBACK_MODEL']);
  }
  if (fallback.provider === primary.provider && fallback.model === primary.model) {
    throw new AiConfigError(['AI_CHAT_FALLBACK_MODEL']);
  }
  return [primary, fallback];
}

export interface ResolvedChatModel {
  ref: ModelRef;
  label: string;
  model: LanguageModel;
}

/**
 * Resolves every model of the chain. A missing key is an error for any of them: a
 * configured fallback that cannot run would silently weaken availability.
 */
export function resolveChatModelChain(
  refs: ModelRef[],
  env: Record<string, string | undefined>,
): ResolvedChatModel[] {
  return refs.map((ref) => ({
    ref,
    label: `${ref.provider}:${ref.model}`,
    model: resolveLanguageModel(ref, env),
  }));
}

/** Errors that say "this provider cannot serve now" — another provider may. */
const FALLBACK_CODES = new Set([
  'AI_PROVIDER_ERROR',
  'AI_PROVIDER_QUOTA',
  'AI_PROVIDER_AUTH',
  'AI_TIMEOUT',
]);

export function shouldFallBack(error: unknown): boolean {
  return error instanceof AiCallError && FALLBACK_CODES.has(error.code);
}

export interface FallbackAttempt {
  label: string;
  errorCode: string | null;
}

/**
 * Runs `call` on each model in order until one succeeds. Falls back only on provider
 * availability errors; invalid output, bad input or a configuration error stop at once.
 * `onAttemptFailed` lets the caller record each failed attempt (e.g. finish its run).
 */
export async function runWithFallback<T>(
  chain: ResolvedChatModel[],
  call: (entry: ResolvedChatModel) => Promise<T>,
  onAttemptFailed?: (entry: ResolvedChatModel, error: unknown, willRetry: boolean) => Promise<void>,
): Promise<{ result: T; used: ResolvedChatModel; attempts: FallbackAttempt[] }> {
  if (chain.length === 0) throw new AiConfigError(['AI_CHAT_MODEL']);
  const attempts: FallbackAttempt[] = [];
  for (const [index, entry] of chain.entries()) {
    try {
      const result = await call(entry);
      attempts.push({ label: entry.label, errorCode: null });
      return { result, used: entry, attempts };
    } catch (error) {
      const willRetry = index < chain.length - 1 && shouldFallBack(error);
      attempts.push({
        label: entry.label,
        errorCode: error instanceof AiCallError ? error.code : 'AI_UNKNOWN',
      });
      await onAttemptFailed?.(entry, error, willRetry);
      if (!willRetry) throw error;
    }
  }
  throw new AiProviderError('AI_PROVIDER_UNSUPPORTED', 'none');
}

/** Price per million tokens in USD, as configured by the owner (never built in). */
export interface ModelPrice {
  inputPerMillion: number;
  outputPerMillion: number;
}

/**
 * AI_MODEL_PRICES_JSON: {"provider:model": {"inputPerMillion": n, "outputPerMillion": n}}.
 * Prices change and differ per contract, so they are configuration; empty = unknown.
 */
export function parseModelPrices(env: Record<string, string | undefined>): Map<string, ModelPrice> {
  const raw = env.AI_MODEL_PRICES_JSON?.trim() ?? '';
  const prices = new Map<string, ModelPrice>();
  if (raw === '') return prices;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new AiConfigError(['AI_MODEL_PRICES_JSON']);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new AiConfigError(['AI_MODEL_PRICES_JSON']);
  }
  for (const [label, value] of Object.entries(parsed)) {
    const price = value as Partial<ModelPrice> | null;
    const input = price?.inputPerMillion;
    const output = price?.outputPerMillion;
    if (
      !/^[a-z0-9][a-z0-9-]*:\S+$/u.test(label) ||
      typeof input !== 'number' ||
      typeof output !== 'number' ||
      !(input >= 0) ||
      !(output >= 0)
    ) {
      throw new AiConfigError(['AI_MODEL_PRICES_JSON']);
    }
    prices.set(label, { inputPerMillion: input, outputPerMillion: output });
  }
  return prices;
}

/** Estimated cost in USD, or null when the price or the token counts are unknown. */
export function estimateCostUsd(
  price: ModelPrice | undefined,
  usage: { inputTokens: number | null; outputTokens: number | null },
): number | null {
  if (price === undefined || usage.inputTokens === null || usage.outputTokens === null) return null;
  return (
    (usage.inputTokens * price.inputPerMillion + usage.outputTokens * price.outputPerMillion) /
    1_000_000
  );
}
