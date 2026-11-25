import pg from 'pg';

import { loadMigrations } from '../migrator';

import { loadCliEnv, runCli } from './env';

/**
 * pnpm --filter @bahith/db exec tsx src/cli/verify-deployment.ts --allow-remote
 * Read-only checks after a deployment: every migration applied, every tenant table under
 * forced RLS, the application roles without BYPASSRLS, and no table granted to a role
 * outside BAHITH. Prints counts only.
 */
runCli(async () => {
  const env = loadCliEnv(process.argv.slice(2), { requireAuth: true });
  const client = new pg.Client({ connectionString: env.adminUrl });
  await client.connect();
  try {
    await client.query('SET default_transaction_read_only = on');
    const expected = (await loadMigrations()).map((m) => m.tag);
    const applied = (
      await client.query<{ tag: string }>('SELECT tag FROM schema_migrations ORDER BY tag')
    ).rows.map((r) => r.tag);
    const missing = expected.filter((tag) => !applied.includes(tag));
    const unforced = (
      await client.query<{ name: string }>(
        `SELECT c.relname AS name FROM pg_class c
           JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'workspace_id'
          WHERE c.relnamespace = 'public'::regnamespace AND c.relkind = 'r'
            AND NOT (c.relrowsecurity AND c.relforcerowsecurity)`,
      )
    ).rows.map((r) => r.name);
    const bypass = (
      await client.query<{ name: string }>(
        `SELECT rolname AS name FROM pg_roles
          WHERE rolname IN ('bahith_app', 'bahith_auth') AND (rolbypassrls OR rolsuper)`,
      )
    ).rows.map((r) => r.name);
    const foreign = (
      await client.query<{ name: string }>(
        `SELECT DISTINCT grantee AS name FROM information_schema.role_table_grants
          WHERE table_schema IN ('public', 'app') AND grantee <> 'PUBLIC'
            AND grantee NOT IN ('bahith_app', 'bahith_auth', 'bahith_identity_provisioner',
                                'neon_superuser', 'cloud_admin', current_user)`,
      )
    ).rows.map((r) => r.name);
    process.stdout.write(
      `migrations ${String(applied.length)}/${String(expected.length)}; ` +
        `tenant tables without forced RLS: ${String(unforced.length)}; ` +
        `app roles with bypass: ${String(bypass.length)}; foreign grantees: ${String(foreign.length)}\n`,
    );
    if (missing.length + unforced.length + bypass.length + foreign.length > 0) {
      throw new Error(
        `DEPLOYMENT_CHECK_FAILED missing=${missing.join(',')} unforced=${unforced.join(',')} ` +
          `bypass=${bypass.join(',')} foreign=${foreign.join(',')}`,
      );
    }
  } finally {
    await client.end();
  }
});
