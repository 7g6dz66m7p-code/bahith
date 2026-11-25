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
/**
 * Roles outside BAHITH holding any privilege on BAHITH's schemas (public, app): on the
 * schemas themselves, tables, views, sequences, columns, functions, and the current
 * owner's default privileges (what new objects will grant). PUBLIC is not a role here.
 */
export async function foreignGrantees(client: pg.ClientBase): Promise<string[]> {
  const rows = await client.query<{ name: string }>(
    `WITH ns AS (SELECT oid FROM pg_namespace WHERE nspname IN ('public', 'app')),
     acls AS (
       SELECT nspacl AS acl FROM pg_namespace WHERE oid IN (SELECT oid FROM ns)
       UNION ALL SELECT relacl FROM pg_class WHERE relnamespace IN (SELECT oid FROM ns)
       UNION ALL SELECT a.attacl FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid
                  WHERE c.relnamespace IN (SELECT oid FROM ns) AND a.attacl IS NOT NULL
       UNION ALL SELECT proacl FROM pg_proc WHERE pronamespace IN (SELECT oid FROM ns)
       UNION ALL SELECT defaclacl FROM pg_default_acl
                  WHERE defaclrole = (SELECT oid FROM pg_roles WHERE rolname = current_user)
     )
     SELECT DISTINCT r.rolname AS name
       FROM acls, aclexplode(acls.acl) x JOIN pg_roles r ON r.oid = x.grantee
      WHERE acls.acl IS NOT NULL
        AND r.rolname <> ALL ($1::text[])
        AND r.rolname NOT IN (current_user, 'pg_database_owner')
      ORDER BY 1`,
    [[...ALLOWED_GRANTEES]],
  );
  return rows.rows.map((row) => row.name);
}

export async function revokeForeignPrivileges(client: pg.ClientBase): Promise<string[]> {
  const foreign = await foreignGrantees(client);
  for (const role of foreign) {
    const statements = await client.query<{ statement: string }>(
      `SELECT format(s, $1::text) AS statement FROM unnest(ARRAY[
         'REVOKE ALL ON ALL TABLES IN SCHEMA public, app FROM %I',
         'REVOKE ALL ON ALL SEQUENCES IN SCHEMA public, app FROM %I',
         'REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public, app FROM %I',
         'REVOKE ALL ON SCHEMA public FROM %I',
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
  const remaining = (await foreignGrantees(client)).filter((name) => foreign.includes(name));
  if (remaining.length > 0) {
    throw new Error(`FOREIGN_PRIVILEGES_REMAIN: ${remaining.join(',')}`);
  }
  return foreign;
}
