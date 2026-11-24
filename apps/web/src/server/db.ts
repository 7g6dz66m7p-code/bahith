import type { Database } from '@bahith/db';
import { createDatabase } from '@bahith/db';

import { getServerEnv } from './env';

// One pool per server process; kept on globalThis so dev hot-reload does not leak pools.
const holder = globalThis as typeof globalThis & {
  __bahithDatabase?: Database;
  __bahithAuthDatabase?: Database;
};

/**
 * The application database (role `bahith_app`, subject to row-level security).
 * Tenant data must be read and written through `getDatabase().withWorkspace(...)`.
 */
export function getDatabase(): Database {
  holder.__bahithDatabase ??= createDatabase({ connectionString: getServerEnv().DATABASE_URL });
  return holder.__bahithDatabase;
}

/**
 * The authentication connection (role `bahith_auth`), for identity data the application
 * role cannot reach (e.g. Telegram links). Never used for research data.
 */
export function getAuthDatabase(): Database {
  const url = process.env.AUTH_DATABASE_URL ?? '';
  if (url === '') throw new Error('AUTH_DATABASE_URL is not set');
  holder.__bahithAuthDatabase ??= createDatabase({ connectionString: url, max: 2 });
  return holder.__bahithAuthDatabase;
}
