import { z } from 'zod';

/**
 * Model selection for the provider layer (ADR-0005).
 *
 * Model names are configuration, never code: each role reads a `provider:model`
 * identifier from the environment. Agents, prompts and RAG arrive in Phase 3.
 */

/** `provider:model`, e.g. the provider key registered in the AI SDK registry plus a model id. */
const modelId = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]*:\S+$/, 'expected "provider:model"')
  .transform((value) => {
    const separator = value.indexOf(':');
    return { provider: value.slice(0, separator), model: value.slice(separator + 1) };
  });

const aiEnvSchema = z.object({
  AI_CHAT_MODEL: modelId,
  AI_EMBEDDING_MODEL: modelId,
  AI_RERANK_MODEL: modelId,
});

export interface ModelRef {
  provider: string;
  model: string;
}

export interface AiConfig {
  chat: ModelRef;
  embedding: ModelRef;
  rerank: ModelRef;
}

/** Raised when model configuration is missing. Names the variables, never their values. */
export class AiConfigError extends Error {
  readonly code = 'AI_CONFIG_INVALID';
  readonly variables: string[];

  constructor(variables: string[]) {
    super(
      `Missing or invalid AI configuration: ${variables.join(', ')}. ` +
        'Each must be set to "provider:model" (see .env.example).',
    );
    this.name = 'AiConfigError';
    this.variables = variables;
  }
}

/**
 * Reads the model configuration. There is no default model: when a variable is missing
 * the feature fails with a clear error instead of silently using something else.
 */
export function loadAiConfig(env: Record<string, string | undefined>): AiConfig {
  const parsed = aiEnvSchema.safeParse(env);
  if (!parsed.success) {
    throw new AiConfigError([...new Set(parsed.error.issues.map((issue) => issue.path.join('.')))]);
  }
  return {
    chat: parsed.data.AI_CHAT_MODEL,
    embedding: parsed.data.AI_EMBEDDING_MODEL,
    rerank: parsed.data.AI_RERANK_MODEL,
  };
}
