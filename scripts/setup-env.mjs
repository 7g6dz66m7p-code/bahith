#!/usr/bin/env node
// Creates the local .env from .env.example: fills non-secret local defaults and
// generates random passwords for the docker-compose services. Local development only.
// It never overwrites a value that is already set, and it prints no secret.
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const examplePath = path.join(root, '.env.example');
const envPath = path.join(root, '.env');

/** URL-safe random secret (hex), so it can be embedded in connection strings as is. */
const secret = () => randomBytes(24).toString('hex');

const parse = (text) =>
  new Map(
    text
      .split('\n')
      .filter((line) => /^[A-Z0-9_]+=/.test(line))
      .map((line) => {
        const index = line.indexOf('=');
        return [line.slice(0, index), line.slice(index + 1)];
      }),
  );

const existing = existsSync(envPath) ? parse(readFileSync(envPath, 'utf8')) : new Map();
const value = (name, fallback) => {
  const current = existing.get(name);
  return current !== undefined && current !== '' ? current : fallback();
};

const env = new Map();
const set = (name, fallback) => env.set(name, value(name, fallback));

set('POSTGRES_USER', () => 'bahith');
set('POSTGRES_PASSWORD', secret);
set('POSTGRES_DB', () => 'bahith');
set('POSTGRES_PORT', () => '5432');
set(
  'DATABASE_ADMIN_URL',
  () =>
    `postgresql://${env.get('POSTGRES_USER')}:${env.get('POSTGRES_PASSWORD')}` +
    `@localhost:${env.get('POSTGRES_PORT')}/${env.get('POSTGRES_DB')}`,
);
set(
  'DATABASE_URL',
  () =>
    `postgresql://bahith_app:${secret()}` +
    `@localhost:${env.get('POSTGRES_PORT')}/${env.get('POSTGRES_DB')}`,
);
set(
  'AUTH_DATABASE_URL',
  () =>
    `postgresql://bahith_auth:${secret()}` +
    `@localhost:${env.get('POSTGRES_PORT')}/${env.get('POSTGRES_DB')}`,
);
set('BETTER_AUTH_SECRET', secret);
set('BETTER_AUTH_URL', () => 'http://localhost:3000');
set('GOOGLE_CLIENT_ID', () => '');
set('GOOGLE_CLIENT_SECRET', () => '');
set('SMTP_HOST', () => 'localhost');
set('SMTP_PORT', () => '1025');
set('SMTP_SECURE', () => 'false');
set('SMTP_FROM', () => 'no-reply@bahith.local');
set('SMTP_USER', () => '');
set('SMTP_PASSWORD', () => '');
set('MAILPIT_HTTP_PORT', () => '8025');

set('REDIS_PASSWORD', secret);
set('REDIS_PORT', () => '6379');
set('REDIS_URL', () => `redis://:${env.get('REDIS_PASSWORD')}@localhost:${env.get('REDIS_PORT')}`);

set('MINIO_PORT', () => '9000');
set('MINIO_CONSOLE_PORT', () => '9001');
set('S3_ENDPOINT', () => `http://localhost:${env.get('MINIO_PORT')}`);
set('S3_REGION', () => 'us-east-1');
set('S3_BUCKET', () => 'bahith-dev');
set('S3_ACCESS_KEY_ID', () => `bahith-${randomBytes(4).toString('hex')}`);
set('S3_SECRET_ACCESS_KEY', secret);
set('S3_FORCE_PATH_STYLE', () => 'true');

// Left empty on purpose: the project owner chooses providers and models (Phase 3).
set('AI_CHAT_MODEL', () => '');
set('AI_EMBEDDING_MODEL', () => '');
set('AI_RERANK_MODEL', () => '');

// Keep the comments and order of .env.example; fail if the two lists ever drift apart.
const exampleNames = [...parse(readFileSync(examplePath, 'utf8')).keys()];
const unknown = exampleNames.filter((name) => !env.has(name));
const undocumented = [...env.keys()].filter((name) => !exampleNames.includes(name));
if (unknown.length > 0 || undocumented.length > 0) {
  process.stderr.write(
    `setup-env is out of sync with .env.example.\n` +
      `  in .env.example only: ${unknown.join(', ') || '-'}\n` +
      `  in setup-env.mjs only: ${undocumented.join(', ') || '-'}\n`,
  );
  process.exit(1);
}

const output = readFileSync(examplePath, 'utf8')
  .split('\n')
  .map((line) => {
    const match = /^([A-Z0-9_]+)=/.exec(line);
    return match ? `${match[1]}=${env.get(match[1])}` : line;
  })
  .join('\n');

// Extra variables the developer added to .env by hand are preserved.
const extras = [...existing].filter(([name]) => !env.has(name));
const extraBlock =
  extras.length > 0
    ? `\n# --- Added locally ---\n${extras.map(([k, v]) => `${k}=${v}`).join('\n')}\n`
    : '';

writeFileSync(envPath, output + extraBlock, { mode: 0o600 });
process.stdout.write(
  `${existing.size > 0 ? 'Updated' : 'Created'} .env (${env.size} variables; existing values kept).\n` +
    'Next: docker compose up -d --wait && pnpm db:migrate && pnpm db:seed && pnpm dev\n',
);
