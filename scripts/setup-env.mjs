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
// --staging writes .env.staging for docker-compose.staging.yml: services are reached by
// their compose names, the app is served on STAGING_WEB_PORT, and every secret is new.
const staging = process.argv.includes('--staging');
const envPath = path.join(root, staging ? '.env.staging' : '.env');
const host = (service) => (staging ? service : 'localhost');
const inside = (port, internal) => (staging ? internal : port);

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
    `@${host('postgres')}:${inside(env.get('POSTGRES_PORT'), '5432')}/${env.get('POSTGRES_DB')}`,
);
set(
  'DATABASE_URL',
  () =>
    `postgresql://bahith_app:${secret()}` +
    `@${host('postgres')}:${inside(env.get('POSTGRES_PORT'), '5432')}/${env.get('POSTGRES_DB')}`,
);
set(
  'AUTH_DATABASE_URL',
  () =>
    `postgresql://bahith_auth:${secret()}` +
    `@${host('postgres')}:${inside(env.get('POSTGRES_PORT'), '5432')}/${env.get('POSTGRES_DB')}`,
);
set('BETTER_AUTH_SECRET', secret);
set('BETTER_AUTH_URL', () => (staging ? 'http://localhost:3200' : 'http://localhost:3000'));
set('GOOGLE_CLIENT_ID', () => '');
set('GOOGLE_CLIENT_SECRET', () => '');
set('SMTP_HOST', () => host('mailpit'));
set('SMTP_PORT', () => '1025');
set('SMTP_SECURE', () => 'false');
set('SMTP_FROM', () => 'no-reply@bahith.local');
set('SMTP_USER', () => '');
set('SMTP_PASSWORD', () => '');
set('MAILPIT_HTTP_PORT', () => '8025');

set('REDIS_PASSWORD', secret);
set('REDIS_PORT', () => '6379');
set(
  'REDIS_URL',
  () =>
    `redis://:${env.get('REDIS_PASSWORD')}@${host('redis')}:${inside(env.get('REDIS_PORT'), '6379')}`,
);

set('MINIO_PORT', () => '9000');
set('MINIO_CONSOLE_PORT', () => '9001');
set('S3_ENDPOINT', () => `http://${host('minio')}:${inside(env.get('MINIO_PORT'), '9000')}`);
set('S3_REGION', () => 'us-east-1');
set('S3_BUCKET', () => (staging ? 'bahith-staging' : 'bahith-dev'));
set('S3_ACCESS_KEY_ID', () => `bahith-${randomBytes(4).toString('hex')}`);
set('S3_SECRET_ACCESS_KEY', secret);
set('S3_FORCE_PATH_STYLE', () => 'true');

// Left empty on purpose: the project owner chooses providers and models (Phase 3).
set('AI_CHAT_MODEL', () => '');
set('AI_EMBEDDING_MODEL', () => '');
set('AI_CHAT_FALLBACK_MODEL', () => '');
set('AI_MODEL_PRICES_JSON', () => '');
set('AI_RERANK_MODEL', () => '');
set('ANTHROPIC_API_KEY', () => '');
set('OPENAI_API_KEY', () => '');

// Left empty on purpose: the project owner provides a project contact mailbox and any keys.
set('SCHOLARLY_CONTACT_EMAIL', () => '');
set('OPENALEX_API_KEY', () => '');
set('SEMANTIC_SCHOLAR_API_KEY', () => '');
set('NCBI_API_KEY', () => '');

// Left empty on purpose: owner decisions (admins, payments, SMS, legacy data, Telegram).
set('PLATFORM_ADMIN_EMAILS', () => '');
set('PAYMENTS_PROVIDER', () => '');
set('PAYMENTS_LIVE_AUTHORIZED', () => '');
set('PDF_CHROMIUM_PATH', () => '');
set('SMS_PROVIDER', () => '');
set('SMS_CAPTURE_DIR', () => '');
set('LEGACY_DATABASE_URL', () => '');
set('TELEGRAM_BOT_TOKEN', () => '');
set('TELEGRAM_AUTH_MAX_AGE_SECONDS', () => '');

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
  `${existing.size > 0 ? 'Updated' : 'Created'} ${path.basename(envPath)} (${env.size} variables; existing values kept).\n` +
    (staging
      ? 'Next: docker compose -f docker-compose.staging.yml --env-file .env.staging up -d --build --wait\n'
      : 'Next: docker compose up -d --wait && pnpm db:migrate && pnpm db:seed && pnpm dev\n'),
);
