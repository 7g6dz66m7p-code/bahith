import { z } from 'zod';

const serverEnvSchema = z.object({
  DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
  REDIS_URL: z.url({ protocol: /^rediss?$/ }),
});

export type ServerEnv = z.infer<typeof serverEnvSchema>;

/** Raised when required configuration is missing. Names the variables, never their values. */
export class EnvError extends Error {
  readonly code = 'CONFIG_INVALID';
  readonly variables: string[];

  constructor(variables: string[]) {
    super(
      `Missing or invalid environment variables: ${variables.join(', ')}. ` +
        'Run "pnpm setup" or see .env.example.',
    );
    this.name = 'EnvError';
    this.variables = variables;
  }
}

export function parseServerEnv(source: Record<string, string | undefined>): ServerEnv {
  const parsed = serverEnvSchema.safeParse(source);
  if (!parsed.success) {
    throw new EnvError([...new Set(parsed.error.issues.map((issue) => issue.path.join('.')))]);
  }
  return parsed.data;
}

let cached: ServerEnv | undefined;

/**
 * Server-side configuration, validated on first use (not at import time, so that
 * `next build` does not need a database). Fails loudly instead of running half-configured.
 */
export function getServerEnv(): ServerEnv {
  cached ??= parseServerEnv(process.env);
  return cached;
}
