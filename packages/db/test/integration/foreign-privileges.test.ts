import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { foreignGrantees, revokeForeignPrivileges } from '../../src/provision';

/**
 * Reproduces what Neon's Data API does on a project (observed on BAHITH's staging
 * project, 2026-11-25): an `authenticated` role with usage on `public` and default
 * privileges giving it full rights on every new table.
 */
describe('privileges of roles outside BAHITH (hosted Postgres add-ons)', () => {
  let admin: pg.Client;

  beforeAll(async () => {
    admin = new pg.Client({ connectionString: inject('adminUrl') });
    await admin.connect();
    await admin.query(`DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
        CREATE ROLE authenticated NOLOGIN;
      END IF; END $$`);
    await admin.query('GRANT USAGE ON SCHEMA public TO authenticated');
    await admin.query(
      'ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO authenticated',
    );
    await admin.query(
      'GRANT SELECT, INSERT, UPDATE, DELETE ON users, projects, payments TO authenticated',
    );
    // Beyond tables: a function, a column and the schema itself.
    await admin.query(
      'GRANT EXECUTE ON FUNCTION app.provision_personal_workspace() TO authenticated',
    );
    await admin.query('GRANT SELECT (email) ON users TO authenticated');
  });

  afterAll(async () => {
    await admin.end();
  });

  const grants = async () =>
    (
      await admin.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM information_schema.role_table_grants
          WHERE grantee = 'authenticated' AND table_schema IN ('public', 'app')`,
      )
    ).rows[0]?.n;

  it('revokes existing and default privileges, so new tables are not exposed either', async () => {
    expect(Number(await grants())).toBeGreaterThan(0);
    expect(await foreignGrantees(admin)).toContain('authenticated');
    expect(await revokeForeignPrivileges(admin)).toContain('authenticated');
    expect(await grants()).toBe('0');
    expect(await foreignGrantees(admin)).toEqual([]);
    const left = await admin.query<{ schema: boolean; fn: boolean; col: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM pg_namespace n, aclexplode(n.nspacl) x
                       WHERE n.nspname = 'public'
                         AND x.grantee = 'authenticated'::regrole) AS schema,
              has_function_privilege('authenticated', 'app.provision_personal_workspace()',
                                     'EXECUTE') AS fn,
              has_column_privilege('authenticated', 'users', 'email', 'SELECT') AS col`,
    );
    // EXECUTE may remain through PUBLIC only if the function grants it to PUBLIC; BAHITH's
    // migrations revoke that, so all three are gone.
    expect(left.rows).toEqual([{ schema: false, fn: false, col: false }]);
    await admin.query('CREATE TABLE public.after_revoke_probe (id int)');
    try {
      expect(await grants()).toBe('0');
    } finally {
      await admin.query('DROP TABLE public.after_revoke_probe');
    }
    // Idempotent; BAHITH's own roles keep their grants.
    expect(await revokeForeignPrivileges(admin)).toEqual([]);
    const own = await admin.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM information_schema.role_table_grants
        WHERE grantee = 'bahith_app' AND table_name = 'projects'`,
    );
    expect(Number(own.rows[0]?.n)).toBeGreaterThan(0);
  });
});
