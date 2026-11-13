import type pg from 'pg';
import { z } from 'zod';

import { APP_ROLE } from './schema/_shared';

const formatted = z.array(z.object({ statement: z.string() })).length(1);

/**
 * Enables LOGIN for the application role and sets its password. Runs as the admin
 * role after migrations. The password comes from the environment at deploy time and
 * is never written to a migration, a log line or a tracked file.
 */
export async function provisionAppRole(client: pg.ClientBase, password: string): Promise<void> {
  // ALTER ROLE cannot take bind parameters; format('%I' / '%L') quotes safely in SQL.
  const result = await client.query(
    `SELECT format('ALTER ROLE %I WITH LOGIN PASSWORD %L', $1::text, $2::text) AS statement`,
    [APP_ROLE, password],
  );
  const [row] = formatted.parse(result.rows);
  if (row === undefined) {
    throw new Error('unreachable: format() returned no row');
  }
  await client.query(row.statement);
}
