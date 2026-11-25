import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';
import type { LanguageModel } from 'ai';
import { z } from 'zod';

import { AiConfigError } from './config';
import type { ModelRef } from './config';

/** Providers the registry knows, and the environment variable holding each one's key. */
export const PROVIDER_KEY_VARIABLES = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
} as const;

export type ProviderId = keyof typeof PROVIDER_KEY_VARIABLES;

export type AiProviderErrorCode = 'AI_PROVIDER_UNSUPPORTED' | 'AI_PROVIDER_KEY_MISSING';

/** Names the provider and variable only; a key value never appears in a message. */
export class AiProviderError extends Error {
  constructor(
    readonly code: AiProviderErrorCode,
    readonly provider: string,
    readonly variable?: string,
  ) {
    super(
      code === 'AI_PROVIDER_UNSUPPORTED'
        ? `Unsupported AI provider "${provider}".`
        : `The ${provider} provider needs ${String(variable)} to be set.`,
    );
    this.name = 'AiProviderError';
  }
}

const modelId = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]*:\S+$/, 'expected "provider:model"')
  .transform((value) => {
    const separator = value.indexOf(':');
    return { provider: value.slice(0, separator), model: value.slice(separator + 1) };
  });

/**
 * The chat model only (the assistant needs no embedding or rerank model). There is no
 * default: a missing AI_CHAT_MODEL fails with AI_CONFIG_INVALID naming the variable.
 */
export function loadChatModelRef(env: Record<string, string | undefined>): ModelRef {
  const parsed = modelId.safeParse(env.AI_CHAT_MODEL);
  if (!parsed.success) throw new AiConfigError(['AI_CHAT_MODEL']);
  return parsed.data;
}

function isProvider(value: string): value is ProviderId {
  return Object.hasOwn(PROVIDER_KEY_VARIABLES, value);
}

/** Resolves `provider:model` to an AI SDK model, with the provider's key from `env`. */
export function resolveLanguageModel(
  ref: ModelRef,
  env: Record<string, string | undefined>,
): LanguageModel {
  if (!isProvider(ref.provider)) throw new AiProviderError('AI_PROVIDER_UNSUPPORTED', ref.provider);
  const variable = PROVIDER_KEY_VARIABLES[ref.provider];
  const apiKey = env[variable]?.trim();
  if (apiKey === undefined || apiKey === '') {
    throw new AiProviderError('AI_PROVIDER_KEY_MISSING', ref.provider, variable);
  }
  switch (ref.provider) {
    case 'anthropic':
      return createAnthropic({ apiKey })(ref.model);
    case 'openai':
      return createOpenAI({ apiKey })(ref.model);
  }
}
