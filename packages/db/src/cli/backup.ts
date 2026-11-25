import { backupDatabase } from '../backup';

import { loadCliEnv, runCli } from './env';

/** pnpm db:backup -- --dir=<directory>: logical backup + roles + manifest (see the runbook). */
runCli(async () => {
  const argv = process.argv.slice(2);
  const env = loadCliEnv(argv);
  const dir = argv.find((arg) => arg.startsWith('--dir='))?.slice('--dir='.length);
  if (dir === undefined || dir === '') throw new Error('Pass --dir=<directory> for the backup.');
  const manifest = await backupDatabase(env.adminUrl, dir);
  const rows = Object.values(manifest.tables).reduce((sum, n) => sum + n, 0);
  process.stdout.write(
    `Backup written to ${dir}: ${String(manifest.migrations.length)} migrations, ` +
      `${String(Object.keys(manifest.tables).length)} tables, ${String(rows)} rows.\n`,
  );
});
