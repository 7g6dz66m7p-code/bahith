import pg from 'pg';

import { loadMigrations } from '../migrator';

import { loadCliEnv, runCli } from './env';

/**
 * pnpm --filter @bahith/db exec tsx src/cli/verify-deployment.ts --allow-remote
 * Checks after a deployment: every migration applied, every tenant table under forced
 * RLS, the application roles without BYPASSRLS, no table granted to a role outside
 * BAHITH, pgvector and the HNSW index present. With --isolation-smoke it also proves
 * tenant isolation on the live server with two synthetic users, inside one transaction
 * that is always rolled back (nothing is left behind). Prints counts only.
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
    const vector = (
      await client.query<{ v: string }>(
        `SELECT extversion AS v FROM pg_extension WHERE extname = 'vector'`,
      )
    ).rows[0]?.v;
    const hnsw = (
      await client.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM pg_indexes
          WHERE tablename = 'chunks' AND indexdef ILIKE '%USING hnsw%'`,
      )
    ).rows[0]?.n;
    const foreignKeys = (
      await client.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM pg_constraint
          WHERE contype = 'f' AND connamespace = 'public'::regnamespace`,
      )
    ).rows[0]?.n;
    process.stdout.write(
      `pgvector ${vector ?? 'MISSING'}; HNSW indexes on chunks: ${hnsw ?? '0'}; ` +
        `foreign keys: ${foreignKeys ?? '0'}\n`,
    );
    if (vector === undefined || hnsw === '0') throw new Error('DEPLOYMENT_CHECK_FAILED vector');
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
    if (process.argv.includes('--isolation-smoke')) await isolationSmoke(client);
  } finally {
    await client.end();
  }
});

/** Two synthetic users; B must not see or write A's rows. Always rolled back. */
async function isolationSmoke(client: pg.Client): Promise<void> {
  await client.query('SET default_transaction_read_only = off');
  await client.query('BEGIN');
  try {
    const tag = crypto.randomUUID();
    const users = await client.query<{ id: string }>(
      `INSERT INTO users (name, email) VALUES
         ('Isolation probe A', $1), ('Isolation probe B', $2) RETURNING id`,
      [`probe-a-${tag}@example.test`, `probe-b-${tag}@example.test`],
    );
    const [a, b] = users.rows.map((row) => row.id);
    if (a === undefined || b === undefined) throw new Error('ISOLATION_SMOKE_SETUP');
    const spaces = await client.query<{ id: string; owner: string }>(
      `SELECT workspace_id AS id, user_id AS owner FROM memberships WHERE user_id = ANY($1::uuid[])`,
      [[a, b]],
    );
    const wsA = spaces.rows.find((row) => row.owner === a)?.id;
    const wsB = spaces.rows.find((row) => row.owner === b)?.id;
    if (wsA === undefined || wsB === undefined) throw new Error('ISOLATION_SMOKE_NO_WORKSPACE');
    await client.query('GRANT bahith_app TO current_user');
    await client.query('SET LOCAL ROLE bahith_app');
    const bind = (user: string, workspace: string) =>
      client.query(
        `SELECT set_config('app.user_id', $1, true), set_config('app.workspace_id', $2, true)`,
        [user, workspace],
      );
    await bind(a, wsA);
    await client.query(`INSERT INTO projects (workspace_id, title) VALUES ($1, 'probe')`, [wsA]);
    const own = await client.query<{ n: string }>('SELECT count(*)::text AS n FROM projects');
    await bind(b, wsB);
    const seen = await client.query<{ n: string }>(
      'SELECT count(*)::text AS n FROM projects WHERE workspace_id = $1',
      [wsA],
    );
    const profiles = await client.query<{ n: string }>(
      'SELECT count(*)::text AS n FROM users WHERE id = $1',
      [a],
    );
    await client.query('SAVEPOINT cross_write');
    let crossWrite = 'allowed';
    try {
      await client.query(`INSERT INTO projects (workspace_id, title) VALUES ($1, 'intruder')`, [
        wsA,
      ]);
    } catch (error) {
      crossWrite = (error as { code?: string }).code ?? 'error';
      await client.query('ROLLBACK TO SAVEPOINT cross_write');
    }
    const unbound = await client.query<{ n: string }>(
      `SELECT set_config('app.workspace_id', '', true),
              (SELECT count(*)::text FROM projects) AS n`,
    );
    const result = {
      ownProjects: own.rows[0]?.n,
      crossRead: seen.rows[0]?.n,
      crossProfile: profiles.rows[0]?.n,
      crossWrite,
      unboundRead: unbound.rows[0]?.n,
    };
    process.stdout.write(`isolation smoke: ${JSON.stringify(result)}\n`);
    if (
      result.ownProjects !== '1' ||
      result.crossRead !== '0' ||
      result.crossProfile !== '0' ||
      result.crossWrite !== '42501' ||
      result.unboundRead !== '0'
    ) {
      throw new Error('ISOLATION_SMOKE_FAILED');
    }
  } finally {
    await client.query('ROLLBACK');
  }
}
