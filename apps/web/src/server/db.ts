import type { Database } from '@bahith/db';
import { createDatabase } from '@bahith/db';

import { getServerEnv } from './env';

// One pool per server process; kept on globalThis so dev hot-reload does not leak pools.
const holder = globalThis as typeof globalThis & { __bahithDatabase?: Database };

/**
 * The application database (role `bahith_app`, subject to row-level security).
 * Tenant data must be read and written through `getDatabase().withWorkspace(...)`.
 */
export function getDatabase(): Database {
  holder.__bahithDatabase ??= createDatabase({ connectionString: getServerEnv().DATABASE_URL });
  return holder.__bahithDatabase;
}
