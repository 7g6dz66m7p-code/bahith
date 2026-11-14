import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { z } from 'zod';

import { DbError } from '../errors';

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

const envSchema = z.object({
  DATABASE_ADMIN_URL: z.url({ protocol: /^postgres(ql)?$/ }),
  DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
});

export interface CliEnv {
  /** Owner/admin connection: runs migrations and seeds. Never used by the app. */
  adminUrl: string;
  /** Application-role connection string (its password provisions the role). */
  appUrl: string;
  appPassword: string;
  /** Dedicated identity connection (required for provisioning migrations). */
  authUrl?: string;
  authPassword?: string;
}

/**
 * Reads the database settings for the CLI from the environment (and the repo-root
 * .env when present). Refuses any non-local database unless `--allow-remote` is passed
 * explicitly: migrating a shared or production database needs the owner's written approval.
 */
export function loadCliEnv(
  argv: readonly string[] = process.argv.slice(2),
  options: { requireAuth?: boolean } = {},
): CliEnv {
  const rootEnv = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../.env');
  if (existsSync(rootEnv)) {
    process.loadEnvFile(rootEnv);
  }

  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const missing = parsed.error.issues.map((issue) => issue.path.join('.')).join(', ');
    throw new DbError(
      'DB_CONFIG_INVALID',
      `Missing or invalid environment variables: ${missing}. Run "pnpm bootstrap" or see .env.example.`,
    );
  }

  const admin = new URL(parsed.data.DATABASE_ADMIN_URL);
  const app = new URL(parsed.data.DATABASE_URL);
  if (!LOCAL_HOSTS.has(admin.hostname) && !argv.includes('--allow-remote')) {
    throw new DbError(
      'DB_REMOTE_TARGET_REFUSED',
      `Refusing to touch the non-local database host "${admin.hostname}". ` +
        'Changing a shared or production database requires explicit written approval; ' +
        'pass --allow-remote only once you have it.',
    );
  }
  if (app.password === '') {
    throw new DbError('DB_CONFIG_INVALID', 'DATABASE_URL must include the application password.');
  }

  const authValue = process.env.AUTH_DATABASE_URL;
  const authResult = z.url({ protocol: /^postgres(ql)?$/ }).safeParse(authValue);
  if (
    (options.requireAuth || (authValue !== undefined && authValue !== '')) &&
    !authResult.success
  ) {
    throw new DbError(
      'DB_CONFIG_INVALID',
      'Missing or invalid environment variable: AUTH_DATABASE_URL.',
    );
  }
  let identity: { authUrl: string; authPassword: string } | undefined;
  if (authResult.success) {
    const auth = new URL(authResult.data);
    if (
      auth.username !== 'bahith_auth' ||
      auth.password === '' ||
      auth.hostname !== admin.hostname ||
      auth.port !== admin.port ||
      auth.pathname !== admin.pathname
    ) {
      throw new DbError(
        'DB_CONFIG_INVALID',
        'AUTH_DATABASE_URL must use bahith_auth on the migration database with a password.',
      );
    }
    identity = { authUrl: authResult.data, authPassword: decodeURIComponent(auth.password) };
  }

  return {
    adminUrl: parsed.data.DATABASE_ADMIN_URL,
    appUrl: parsed.data.DATABASE_URL,
    appPassword: decodeURIComponent(app.password),
    ...identity,
  };
}

/** Runs a CLI entry point, printing a single clean error line on failure. */
export function runCli(main: () => Promise<void>): void {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`error: ${message}\n`);
    process.exitCode = 1;
  });
}
