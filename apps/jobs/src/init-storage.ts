/**
 * Creates the object-storage bucket for local development (`pnpm storage:init`).
 * Production buckets are provisioned by infrastructure, never by the application.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createStorage, parseStorageConfig } from '@bahith/pipeline';

const rootEnv = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../.env');
if (existsSync(rootEnv)) process.loadEnvFile(rootEnv);

const config = parseStorageConfig(process.env);
const host = config.endpoint === undefined ? '' : new URL(config.endpoint).hostname;
// The staging stack's own MinIO is reached by its compose name; pass --staging for it.
const allowed = [
  'localhost',
  '127.0.0.1',
  '::1',
  ...(process.argv.includes('--staging') ? ['minio'] : []),
];
if (!allowed.includes(host)) {
  process.stderr.write('error: storage:init only creates buckets on a local endpoint.\n');
  process.exit(1);
}
await createStorage(config).ensureBucket();
process.stdout.write(`Bucket "${config.bucket}" is ready.\n`);
