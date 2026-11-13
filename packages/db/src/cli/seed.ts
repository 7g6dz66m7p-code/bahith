import pg from 'pg';

import { seedReferenceData } from '../seed';

import { loadCliEnv, runCli } from './env';

runCli(async () => {
  const env = loadCliEnv();
  const client = new pg.Client({ connectionString: env.adminUrl });
  await client.connect();
  try {
    await seedReferenceData(client);
    process.stdout.write('Seeded reference data (plans).\n');
  } finally {
    await client.end();
  }
});
