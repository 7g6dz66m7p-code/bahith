import { PostgreSqlContainer } from '@testcontainers/postgresql';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import pg from 'pg';

import { migrateUp } from './migrator';
import { provisionAppRole } from './provision';
import { APP_ROLE } from './schema/_shared';

/** Same image as docker-compose.yml: Postgres 16 with pgvector. */
export const POSTGRES_IMAGE = 'pgvector/pgvector:pg16';

export interface TestDatabase {
  container: StartedPostgreSqlContainer;
  /** Superuser connection string — migrations and fixtures that must bypass RLS. */
  adminUrl: string;
  /** Application-role connection string — what the product code uses. */
  appUrl: string;
  stop(): Promise<void>;
}

/**
 * Starts a throwaway Postgres (Testcontainers), applies every migration and provisions
 * the application role, exactly like `pnpm db:migrate` does for local development.
 * Test-only helper: the password below exists only inside the disposable container.
 */
export async function startTestDatabase(): Promise<TestDatabase> {
  const container = await new PostgreSqlContainer(POSTGRES_IMAGE).start();
  const adminUrl = container.getConnectionUri();

  const appPassword = crypto.randomUUID();
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  try {
    await migrateUp(admin);
    await provisionAppRole(admin, appPassword);
  } finally {
    await admin.end();
  }

  const appUrl = new URL(adminUrl);
  appUrl.username = APP_ROLE;
  appUrl.password = appPassword;

  return {
    container,
    adminUrl,
    appUrl: appUrl.toString(),
    async stop() {
      await container.stop();
    },
  };
}
