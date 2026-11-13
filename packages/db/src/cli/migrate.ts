import pg from 'pg';

import { migrateUp } from '../migrator';
import { provisionAppRole } from '../provision';

import { loadCliEnv, runCli } from './env';

runCli(async () => {
  const env = loadCliEnv();
  const client = new pg.Client({ connectionString: env.adminUrl });
  await client.connect();
  try {
    const applied = await migrateUp(client);
    await provisionAppRole(client, env.appPassword);
    process.stdout.write(
      applied.length === 0
        ? 'Database is up to date.\n'
        : `Applied ${applied.length} migration(s): ${applied.join(', ')}\n`,
    );
  } finally {
    await client.end();
  }
});
