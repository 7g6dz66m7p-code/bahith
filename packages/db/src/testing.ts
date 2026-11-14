import { PostgreSqlContainer } from '@testcontainers/postgresql';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import pg from 'pg';

import { migrateUp } from './migrator';
import { provisionAppRole, provisionAuthRole } from './provision';
import { APP_ROLE, AUTH_ROLE } from './schema/_shared';
export { seedReferenceData } from './seed';

/** Same image as docker-compose.yml: Postgres 16 with pgvector. */
export const POSTGRES_IMAGE = 'pgvector/pgvector:pg16';

export interface TestDatabase {
  container: StartedPostgreSqlContainer;
  /** Superuser connection string — migrations and fixtures that must bypass RLS. */
  adminUrl: string;
  /** Application-role connection string — what the product code uses. */
  appUrl: string;
  /** Private authentication role; identity fixtures use this connection only. */
  authUrl: string;
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
  const authPassword = crypto.randomUUID();
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  try {
    await migrateUp(admin);
    await provisionAppRole(admin, appPassword);
    await provisionAuthRole(admin, authPassword);
  } finally {
    await admin.end();
  }

  const appUrl = new URL(adminUrl);
  appUrl.username = APP_ROLE;
  appUrl.password = appPassword;
  const authUrl = new URL(adminUrl);
  authUrl.username = AUTH_ROLE;
  authUrl.password = authPassword;

  return {
    container,
    adminUrl,
    appUrl: appUrl.toString(),
    authUrl: authUrl.toString(),
    async stop() {
      await container.stop();
    },
  };
}
