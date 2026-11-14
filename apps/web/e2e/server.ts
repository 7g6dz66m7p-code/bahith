/** Real, isolated services for browser tests. Credentials never leave this child process. */
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';

import { createDatabase } from '@bahith/db';
import { seedReferenceData, startTestDatabase } from '@bahith/db/testing';
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
  NEXT_TELEMETRY_DISABLED: '1',
  REDIS_URL: `redis://${redis.getHost()}:${redis.getMappedPort(6379)}`,
};
let child: ChildProcess | undefined;
let closing = false;
async function cleanup() {
  if (closing) return;
  closing = true;
  child?.kill('SIGTERM');
  await Promise.allSettled([
    database.stop(),
    mail.stop(),
    redis.stop(),
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
      }),
      { mode: 0o600 },
    );
    process.exitCode = await next(['start', '--port', '3100']);
  }
} finally {
  await cleanup();
}
