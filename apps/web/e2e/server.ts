/** Real, isolated services for browser tests. Credentials never leave this child process. */
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';

import { createDatabase } from '@bahith/db';
import { seedReferenceData, startTestDatabase } from '@bahith/db/testing';
import { createStorage } from '@bahith/pipeline';
import { GenericContainer, Wait } from 'testcontainers';

const require = createRequire(import.meta.url);
const appDir = path.resolve(import.meta.dirname, '..');
const runtimeFile = path.join(appDir, '.next', 'e2e-runtime.json');
const database = await startTestDatabase();
const mail = await new GenericContainer('axllent/mailpit:v1.33.1')
  .withExposedPorts(1025, 8025)
  .withWaitStrategy(Wait.forListeningPorts())
  .start();
const redis = await new GenericContainer('redis:7-alpine').withExposedPorts(6379).start();
// Object storage for uploaded sources; credentials exist only inside this container.
const s3User = `e2e-${crypto.randomUUID().slice(0, 8)}`;
const s3Secret = crypto.randomUUID();
const minio = await new GenericContainer('coollabsio/minio:RELEASE.2025-10-15T17-29-55Z')
  .withEnvironment({ MINIO_ROOT_USER: s3User, MINIO_ROOT_PASSWORD: s3Secret })
  .withCommand(['server', '/data'])
  .withExposedPorts(9000)
  .withWaitStrategy(Wait.forHttp('/minio/health/live', 9000))
  .start();
const storageEnv = {
  S3_ENDPOINT: `http://${minio.getHost()}:${minio.getMappedPort(9000)}`,
  S3_REGION: 'us-east-1',
  S3_BUCKET: 'bahith-e2e',
  S3_ACCESS_KEY_ID: s3User,
  S3_SECRET_ACCESS_KEY: s3Secret,
  S3_FORCE_PATH_STYLE: 'true',
};
await createStorage({
  endpoint: storageEnv.S3_ENDPOINT,
  region: storageEnv.S3_REGION,
  bucket: storageEnv.S3_BUCKET,
  accessKeyId: s3User,
  secretAccessKey: s3Secret,
  forcePathStyle: true,
}).ensureBucket();
const admin = createDatabase({ connectionString: database.adminUrl });
const client = await admin.pool.connect();
try {
  await seedReferenceData(client);
} finally {
  client.release();
  await admin.close();
}
const env = {
  ...process.env,
  DATABASE_URL: database.appUrl,
  AUTH_DATABASE_URL: database.authUrl,
  BETTER_AUTH_SECRET: crypto.randomUUID() + crypto.randomUUID(),
  BETTER_AUTH_URL: 'http://localhost:3100',
  SMTP_HOST: mail.getHost(),
  SMTP_PORT: String(mail.getMappedPort(1025)),
  SMTP_SECURE: 'false',
  SMTP_FROM: 'tests@bahith.local',
  SMTP_USER: '',
  SMTP_PASSWORD: '',
  GOOGLE_CLIENT_ID: '',
  GOOGLE_CLIENT_SECRET: '',
  // Registry lookups stay off in e2e (no network dependency); the spec checks the clear
  // "not configured" path. Live registry checks are in packages/scholarly test:live.
  SCHOLARLY_CONTACT_EMAIL: '',
  // No AI provider in e2e: the assistant must say it is not configured (never fake it).
  AI_CHAT_MODEL: '',
  AI_EMBEDDING_MODEL: '',
  ANTHROPIC_API_KEY: '',
  OPENAI_API_KEY: '',
  NEXT_TELEMETRY_DISABLED: '1',
  REDIS_URL: `redis://${redis.getHost()}:${redis.getMappedPort(6379)}`,
  ...storageEnv,
};
// The real background workers: Python extraction (OCR) and Node ingestion.
const rootDir = path.resolve(appDir, '../..');
const workers: ChildProcess[] = [
  spawn('uv', ['run', '--quiet', 'python', '-m', 'bahith_worker'], {
    cwd: path.join(rootDir, 'apps/worker'),
    env,
    stdio: ['ignore', 'ignore', 'inherit'],
  }),
  spawn(process.execPath, [require.resolve('tsx/cli'), 'src/main.ts'], {
    cwd: path.join(rootDir, 'apps/jobs'),
    env,
    stdio: ['ignore', 'ignore', 'inherit'],
  }),
];
let child: ChildProcess | undefined;
let closing = false;
async function cleanup() {
  if (closing) return;
  closing = true;
  child?.kill('SIGTERM');
  for (const worker of workers) worker.kill('SIGTERM');
  await Promise.allSettled([
    database.stop(),
    mail.stop(),
    redis.stop(),
    minio.stop(),
    rm(runtimeFile, { force: true }),
  ]);
}
process.on('SIGTERM', () => {
  void cleanup().then(() => process.exit(0));
});
process.on('SIGINT', () => {
  void cleanup().then(() => process.exit(0));
});
function next(args: string[]): Promise<number> {
  return new Promise((resolve, reject) => {
    child = spawn(process.execPath, [require.resolve('next/dist/bin/next'), ...args], {
      cwd: appDir,
      env,
      stdio: 'inherit',
    });
    child.once('error', reject);
    child.once('exit', (code) => {
      resolve(code ?? 1);
    });
  });
}
try {
  const built = await next(['build']);
  if (built !== 0) process.exitCode = built;
  else {
    await writeFile(
      runtimeFile,
      JSON.stringify({
        mailUrl: `http://${mail.getHost()}:${mail.getMappedPort(8025)}`,
        authUrl: database.authUrl,
        // Test-only: lets a spec add a member to a workspace (there is no invitation flow yet).
        appUrl: database.appUrl,
      }),
      { mode: 0o600 },
    );
    process.exitCode = await next(['start', '--port', '3100']);
  }
} finally {
  await cleanup();
}
