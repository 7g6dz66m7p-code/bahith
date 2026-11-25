import { restoreDatabase } from '../backup';

import { loadCliEnv, runCli } from './env';

/**
 * pnpm db:restore -- --dir=<directory>: restores into the EMPTY database named by
 * DATABASE_ADMIN_URL, verifies checksums, migrations and row counts. Then run
 * pnpm db:migrate to set the role passwords from the environment.
 */
runCli(async () => {
  const argv = process.argv.slice(2);
  const env = loadCliEnv(argv);
  const dir = argv.find((arg) => arg.startsWith('--dir='))?.slice('--dir='.length);
  if (dir === undefined || dir === '') throw new Error('Pass --dir=<backup directory>.');
  const report = await restoreDatabase(env.adminUrl, dir);
  process.stdout.write(
    `Restored and verified in ${String(Math.round(report.durationMs / 1000))} s ` +
      `(${String(report.manifest.migrations.length)} migrations, row counts match).\n` +
      (report.rolesMapped.length === 0
        ? ''
        : `Source-server roles mapped to this server's admin: ${report.rolesMapped.join(', ')}.\n`),
  );
});
