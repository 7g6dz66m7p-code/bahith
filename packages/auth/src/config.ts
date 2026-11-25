import { z } from 'zod';

/** Configuration errors expose variable names only, never supplied values. */
export class AuthConfigError extends Error {
  readonly code = 'AUTH_CONFIG_INVALID';

  constructor(readonly variables: string[]) {
    super(`Missing or invalid authentication configuration: ${variables.join(', ')}.`);
    this.name = 'AuthConfigError';
  }
}

const blankToMissing = (value: unknown): unknown => (value === '' ? undefined : value);
const optionalString = z.preprocess(blankToMissing, z.string().min(1).optional());
const loopbackHosts = new Set(['localhost', '127.0.0.1', '[::1]']);

const authEnvSchema = z
  .object({
    AUTH_DATABASE_URL: z
      .url({ protocol: /^postgres(ql)?$/u })
      .refine((value) => new URL(value).username === 'bahith_auth'),
    BETTER_AUTH_SECRET: z.string().min(32),
    BETTER_AUTH_URL: z.url().refine((value) => {
      const url = new URL(value);
      return (
        (url.protocol === 'https:' ||
          (url.protocol === 'http:' && loopbackHosts.has(url.hostname))) &&
        url.username === '' &&
        url.password === '' &&
        url.search === '' &&
        url.hash === '' &&
        (url.pathname === '' || url.pathname === '/')
      );
    }),
    GOOGLE_CLIENT_ID: optionalString,
    GOOGLE_CLIENT_SECRET: optionalString,
    SMTP_HOST: z.preprocess(
      blankToMissing,
      z
        .string()
        .regex(/^[a-zA-Z0-9.-]+$/u)
        .max(253)
        .optional(),
    ),
    SMTP_PORT: z.preprocess(blankToMissing, z.coerce.number().int().min(1).max(65535).optional()),
    SMTP_SECURE: z.preprocess(blankToMissing, z.enum(['true', 'false']).optional()),
    SMTP_USER: optionalString,
    SMTP_PASSWORD: optionalString,
    SMTP_FROM: z.preprocess(blankToMissing, z.email().optional()),
  })
  .superRefine((value, ctx) => {
    const requirePair = (left: string | undefined, right: string | undefined, fields: string[]) => {
      if ((left === undefined) !== (right === undefined)) {
        for (const field of fields) {
          ctx.addIssue({ code: 'custom', path: [field], message: 'Both variables are required.' });
        }
      }
    };
    requirePair(value.GOOGLE_CLIENT_ID, value.GOOGLE_CLIENT_SECRET, [
      'GOOGLE_CLIENT_ID',
      'GOOGLE_CLIENT_SECRET',
    ]);
    requirePair(value.SMTP_USER, value.SMTP_PASSWORD, ['SMTP_USER', 'SMTP_PASSWORD']);
    const hasSmtp = [
      value.SMTP_HOST,
      value.SMTP_PORT,
      value.SMTP_SECURE,
      value.SMTP_USER,
      value.SMTP_PASSWORD,
      value.SMTP_FROM,
    ].some((field) => field !== undefined);
    if (hasSmtp) {
      for (const [field, entry] of [
        ['SMTP_HOST', value.SMTP_HOST],
        ['SMTP_FROM', value.SMTP_FROM],
      ] as const) {
        if (entry === undefined) {
          ctx.addIssue({
            code: 'custom',
            path: [field],
            message: 'SMTP delivery requires this field.',
          });
        }
      }
    }
  });

export interface AuthSmtpConfig {
  host: string;
  port: number;
  secure: boolean;
  from: string;
  user?: string;
  password?: string;
}

export interface AuthConfig {
  databaseUrl: string;
  secret: string;
  baseUrl: string;
  google?: { clientId: string; clientSecret: string };
  smtp?: AuthSmtpConfig;
}

/** No default auth secret, database credentials, or email delivery provider. */
export function parseAuthConfig(env: Record<string, string | undefined>): AuthConfig {
  const result = authEnvSchema.safeParse(env);
  if (!result.success) {
    throw new AuthConfigError([
      ...new Set(result.error.issues.map((issue) => issue.path.join('.'))),
    ]);
  }
  const value = result.data;
  return {
    databaseUrl: value.AUTH_DATABASE_URL,
    secret: value.BETTER_AUTH_SECRET,
    baseUrl: new URL(value.BETTER_AUTH_URL).origin,
    ...(value.GOOGLE_CLIENT_ID !== undefined && value.GOOGLE_CLIENT_SECRET !== undefined
      ? { google: { clientId: value.GOOGLE_CLIENT_ID, clientSecret: value.GOOGLE_CLIENT_SECRET } }
      : {}),
    ...(value.SMTP_HOST !== undefined && value.SMTP_FROM !== undefined
      ? {
          smtp: {
            host: value.SMTP_HOST,
            port: value.SMTP_PORT ?? (value.SMTP_SECURE === 'true' ? 465 : 587),
            secure: value.SMTP_SECURE === 'true',
            from: value.SMTP_FROM,
            ...(value.SMTP_USER !== undefined && value.SMTP_PASSWORD !== undefined
              ? { user: value.SMTP_USER, password: value.SMTP_PASSWORD }
              : {}),
          },
        }
      : {}),
  };
}
