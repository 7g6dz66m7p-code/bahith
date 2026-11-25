import type pg from 'pg';
import { z } from 'zod';

import { APP_ROLE, AUTH_ROLE } from './schema/_shared';

const formatted = z.array(z.object({ statement: z.string() })).length(1);

/**
 * Enables LOGIN for the application role and sets its password. Runs as the admin
 * role after migrations. The password comes from the environment at deploy time and
 * is never written to a migration, a log line or a tracked file.
 */
export async function provisionAppRole(client: pg.ClientBase, password: string): Promise<void> {
  return provisionLoginRole(client, APP_ROLE, password);
}

/** Private identity connection; never grant this role access to research tables. */
export async function provisionAuthRole(client: pg.ClientBase, password: string): Promise<void> {
  return provisionLoginRole(client, AUTH_ROLE, password);
}

async function provisionLoginRole(
  client: pg.ClientBase,
  role: string,
  password: string,
): Promise<void> {
  // ALTER ROLE cannot take bind parameters; format('%I' / '%L') quotes safely in SQL.
  const result = await client.query(
    `SELECT format('ALTER ROLE %I WITH LOGIN PASSWORD %L', $1::text, $2::text) AS statement`,
    [role, password],
  );
  const [row] = formatted.parse(result.rows);
  if (row === undefined) {
    throw new Error('unreachable: format() returned no row');
  }
  await client.query(row.statement);
}

/** Roles that may hold privileges on BAHITH's objects; anything else is foreign. */
const ALLOWED_GRANTEES = new Set([
  APP_ROLE,
  AUTH_ROLE,
  'bahith_identity_provisioner',
  // Platform administrators of managed Postgres (Neon) and the owner itself.
  'neon_superuser',
  'cloud_admin',
]);

/**
 * Hosted Postgres can add roles and default privileges of its own: Neon's Data API
 * grants `authenticated` full rights on every new table in `public` and serves them
 * over REST. BAHITH reaches its data only through bahith_app / bahith_auth, so after
 * every migration all privileges of other roles on BAHITH's schemas are revoked (also
 * for future objects), and any that remain make provisioning fail.
 */
export async function revokeForeignPrivileges(client: pg.ClientBase): Promise<string[]> {
  const owner = (await client.query<{ name: string }>('SELECT current_user AS name')).rows[0]?.name;
  const allowed = new Set([...ALLOWED_GRANTEES, owner ?? '']);
  const foreign = (
    await client.query<{ grantee: string }>(
      `SELECT DISTINCT grantee FROM information_schema.role_table_grants
        WHERE table_schema IN ('public', 'app') AND grantee <> 'PUBLIC'
       UNION
       SELECT DISTINCT r.rolname FROM pg_default_acl d, aclexplode(d.defaclacl) a
         JOIN pg_roles r ON r.oid = a.grantee
        WHERE d.defaclrole = (SELECT oid FROM pg_roles WHERE rolname = current_user)`,
    )
  ).rows
    .map((row) => row.grantee)
    .filter((name) => !allowed.has(name));
  for (const role of foreign) {
    const statements = await client.query<{ statement: string }>(
      `SELECT format(s, $1::text) AS statement FROM unnest(ARRAY[
         'REVOKE ALL ON ALL TABLES IN SCHEMA public, app FROM %I',
         'REVOKE ALL ON ALL SEQUENCES IN SCHEMA public, app FROM %I',
         'REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public, app FROM %I',
         'REVOKE ALL ON SCHEMA app FROM %I',
         'ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM %I',
         'ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM %I',
         'ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON FUNCTIONS FROM %I',
         'ALTER DEFAULT PRIVILEGES REVOKE ALL ON TABLES FROM %I',
         'ALTER DEFAULT PRIVILEGES REVOKE ALL ON SEQUENCES FROM %I',
         'ALTER DEFAULT PRIVILEGES REVOKE ALL ON FUNCTIONS FROM %I'
       ]) AS s`,
      [role],
    );
    for (const row of statements.rows) await client.query(row.statement);
  }
  const remaining = await client.query<{ grantee: string }>(
    `SELECT DISTINCT grantee FROM information_schema.role_table_grants
      WHERE table_schema IN ('public', 'app') AND grantee = ANY($1::text[])`,
    [foreign],
  );
  if (remaining.rows.length > 0) {
    throw new Error(`FOREIGN_PRIVILEGES_REMAIN: ${remaining.rows.map((r) => r.grantee).join(',')}`);
  }
  return foreign;
}
