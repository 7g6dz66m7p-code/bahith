import pg from 'pg';
import { z } from 'zod';

import { rollbackLast } from '../migrator';

import { loadCliEnv, runCli } from './env';

runCli(async () => {
  const argv = process.argv.slice(2);
  const env = loadCliEnv(argv);
  const stepsArg = argv.find((arg) => arg.startsWith('--steps='));
  const steps = z.coerce
    .number()
    .int()
    .positive()
    .parse(stepsArg?.slice('--steps='.length) ?? 1);

  const client = new pg.Client({ connectionString: env.adminUrl });
  await client.connect();
  try {
    const reverted = await rollbackLast(client, steps);
    process.stdout.write(
      reverted.length === 0
        ? 'Nothing to roll back.\n'
        : `Rolled back ${reverted.length} migration(s): ${reverted.join(', ')}\n`,
    );
  } finally {
    await client.end();
  }
});
