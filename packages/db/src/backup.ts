import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import pg from 'pg';
import { z } from 'zod';

const run = promisify(execFile);

/** Connection settings for the pg client tools, passed by environment (never argv). */
function pgEnv(url: string): NodeJS.ProcessEnv {
  const parsed = new URL(url);
  return {
    PATH: process.env.PATH,
    PGHOST: parsed.hostname,
    PGPORT: parsed.port === '' ? '5432' : parsed.port,
    PGUSER: decodeURIComponent(parsed.username),
    PGPASSWORD: decodeURIComponent(parsed.password),
    PGDATABASE: parsed.pathname.slice(1),
    PGSSLMODE: parsed.searchParams.get('sslmode') ?? 'prefer',
  };
}

const ROLE_PREFIX = 'bahith_';

/**
 * Role statements of the application roles only, from `pg_dumpall --roles-only
 * --no-role-passwords`. Passwords are never in a backup: they are set again at restore
 * time by the normal provisioning step (pnpm db:migrate) from the deploy environment.
 */
function appRoleStatements(dump: string): string[] {
  return dump
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => /^(CREATE ROLE|ALTER ROLE|GRANT) /u.test(line))
    .filter((line) => {
      const roles = [...line.matchAll(/\b([a-z_][a-z0-9_]*)\b/gu)]
        .map((m) => m[1] ?? '')
        .filter((word) => word.startsWith(ROLE_PREFIX));
      return (
        roles.length > 0 && !/\bGRANTED BY\b/u.test(line.replace(/GRANTED BY bahith_\w+/u, ''))
      );
    });
}

const IDENT = String.raw`"(?:[^"]|"")+"|[A-Za-z_][A-Za-z0-9_$]*`;
const unquote = (ident: string) =>
  ident.startsWith('"') ? ident.slice(1, -1).replaceAll('""', '"') : ident;
const identList = (list: string) =>
  [...list.matchAll(new RegExp(IDENT, 'gu'))]
    .map((m) => m[0])
    .filter((ident) => ident.toUpperCase() !== 'PUBLIC' && ident.toUpperCase() !== 'GROUP')
    .map(unquote);

/**
 * Every role a schema-only restore script names: object owners, grantees and grantors,
 * default-privilege owners and policy roles. A backup taken on one server (e.g. Neon,
 * whose owner is `neondb_owner` and which grants to `neon_superuser`) names roles an empty
 * target server does not have; restore needs to know them before pg_restore runs.
 */
export function referencedRoles(script: string): string[] {
  const roles = new Set<string>();
  const add = (list: string | undefined) => {
    if (list !== undefined) for (const role of identList(list)) roles.add(role);
  };
  for (const raw of script.split('\n')) {
    const line = raw.trim();
    add(new RegExp(`\\bOWNER TO (${IDENT});$`, 'u').exec(line)?.[1]);
    add(new RegExp(`\\bFOR ROLE ((?:${IDENT})(?:, (?:${IDENT}))*)`, 'u').exec(line)?.[1]);
    add(new RegExp(`\\bGRANTED BY (${IDENT})`, 'u').exec(line)?.[1]);
    const grant = new RegExp(
      `^(?:ALTER DEFAULT PRIVILEGES .*?)?(?:GRANT|REVOKE) .* (?:TO|FROM) ((?:${IDENT})(?:, (?:${IDENT}))*)(?: WITH GRANT OPTION)?(?: GRANTED BY .*)?;$`,
      'u',
    ).exec(line);
    add(grant?.[1]);
    add(
      new RegExp(
        `^CREATE POLICY .* TO ((?:${IDENT})(?:, (?:${IDENT}))*)(?: USING| WITH CHECK|;|$)`,
        'u',
      ).exec(line)?.[1],
    );
  }
  return [...roles].sort();
}

export const backupManifestSchema = z.strictObject({
  format: z.literal('bahith-backup-v1'),
  createdAt: z.string(),
  database: z.string(),
  migrations: z.array(z.string()),
  tables: z.record(z.string(), z.number().int().min(0)),
  files: z.record(z.string(), z.string().regex(/^[a-f0-9]{64}$/u)),
  pgDump: z.string(),
});

export type BackupManifest = z.infer<typeof backupManifestSchema>;

const sha256 = (data: Buffer | string) => createHash('sha256').update(data).digest('hex');

async function tableCounts(client: pg.ClientBase): Promise<Record<string, number>> {
  const tables = await client.query<{ name: string }>(
    `SELECT tablename AS name FROM pg_tables WHERE schemaname = 'public' ORDER BY 1`,
  );
  const counts: Record<string, number> = {};
  for (const { name } of tables.rows) {
    const result = await client.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM ${pg.escapeIdentifier(name)}`,
    );
    counts[name] = Number(result.rows[0]?.n ?? 0);
  }
  return counts;
}

/**
 * Full logical backup into `directory`: database.dump (pg_dump custom format, schema +
 * data + RLS policies + grants), roles.sql (application roles, no passwords) and
 * manifest.json (applied migrations, row counts per table, SHA-256 of each file).
 * Needs an admin connection (to read every tenant's rows past RLS).
 */
export async function backupDatabase(adminUrl: string, directory: string): Promise<BackupManifest> {
  await mkdir(directory, { recursive: true });
  const env = pgEnv(adminUrl);
  const dumpPath = path.join(directory, 'database.dump');
  await run('pg_dump', ['--format=custom', '--no-password', `--file=${dumpPath}`], {
    env,
    maxBuffer: 16 * 1024 * 1024,
  });
  const { stdout: rolesDump } = await run(
    'pg_dumpall',
    ['--roles-only', '--no-role-passwords', '--no-password', `--database=${env.PGDATABASE ?? ''}`],
    { env, maxBuffer: 16 * 1024 * 1024 },
  );
  const roles = `${appRoleStatements(rolesDump).join('\n')}\n`;
  await writeFile(path.join(directory, 'roles.sql'), roles);
  const { stdout: version } = await run('pg_dump', ['--version'], { env });

  const client = new pg.Client({ connectionString: adminUrl });
  await client.connect();
  try {
    const migrations = await client.query<{ tag: string }>(
      'SELECT tag FROM schema_migrations ORDER BY applied_at, tag',
    );
    const manifest: BackupManifest = {
      format: 'bahith-backup-v1',
      createdAt: new Date().toISOString(),
      database: env.PGDATABASE ?? '',
      migrations: migrations.rows.map((row) => row.tag),
      tables: await tableCounts(client),
      files: {
        'database.dump': sha256(await readFile(dumpPath)),
        'roles.sql': sha256(roles),
      },
      pgDump: version.trim(),
    };
    await writeFile(
      path.join(directory, 'manifest.json'),
      `${JSON.stringify(manifest, null, 2)}\n`,
    );
    return manifest;
  } finally {
    await client.end();
  }
}

export interface RestoreReport {
  manifest: BackupManifest;
  durationMs: number;
  tables: Record<string, number>;
  /** Source-server roles (e.g. neondb_owner) whose objects now belong to the target admin. */
  rolesMapped: string[];
}

/**
 * Restores a backup into an EMPTY database (refuses otherwise): checks every file's
 * SHA-256, re-creates the application roles (and NOLOGIN stand-ins for the source server's
 * own roles), runs pg_restore with --exit-on-error, then proves the result: same applied migrations and the same row count in every table.
 * Role passwords are set afterwards by `pnpm db:migrate` (provisioning).
 */
export async function restoreDatabase(adminUrl: string, directory: string): Promise<RestoreReport> {
  const started = Date.now();
  const manifest = backupManifestSchema.parse(
    JSON.parse(await readFile(path.join(directory, 'manifest.json'), 'utf8')),
  );
  for (const [file, digest] of Object.entries(manifest.files)) {
    if (sha256(await readFile(path.join(directory, file))) !== digest) {
      throw new Error(`Backup file ${file} does not match its checksum; refusing to restore.`);
    }
  }
  const standIns: string[] = [];
  const client = new pg.Client({ connectionString: adminUrl });
  await client.connect();
  try {
    const existing = await client.query(
      `SELECT 1 FROM pg_tables WHERE schemaname = 'public' LIMIT 1`,
    );
    if (existing.rowCount !== 0)
      throw new Error('The target database is not empty; refusing to restore.');
    for (const statement of (await readFile(path.join(directory, 'roles.sql'), 'utf8')).split(
      '\n',
    )) {
      if (statement.trim() === '') continue;
      try {
        await client.query(statement);
      } catch (error) {
        // An existing role (same cluster) is fine; anything else is not.
        if (!(error instanceof Error && 'code' in error && error.code === '42710')) throw error;
      }
    }
    // Roles of the source server that this server lacks (Neon's neondb_owner, neon_superuser)
    // are created as NOLOGIN stand-ins so ownership and grants restore exactly; afterwards
    // their objects go to this server's admin and the stand-ins are dropped. Application
    // roles (bahith_*) are never stand-ins: they come from roles.sql above.
    const { stdout: script } = await run(
      'pg_restore',
      ['--schema-only', '--file=-', path.join(directory, 'database.dump')],
      { env: pgEnv(adminUrl), maxBuffer: 64 * 1024 * 1024 },
    );
    const present = new Set(
      (await client.query<{ name: string }>('SELECT rolname AS name FROM pg_roles')).rows.map(
        (row) => row.name,
      ),
    );
    for (const role of referencedRoles(script)) {
      if (present.has(role)) continue;
      if (role.startsWith(ROLE_PREFIX)) {
        throw new Error(`Application role ${role} is missing from roles.sql; refusing to restore.`);
      }
      await client.query(`CREATE ROLE ${pg.escapeIdentifier(role)} NOLOGIN`);
      standIns.push(role);
    }
  } finally {
    await client.end();
  }
  await run(
    'pg_restore',
    [
      '--exit-on-error',
      '--no-password',
      `--dbname=${pgEnv(adminUrl).PGDATABASE ?? ''}`,
      path.join(directory, 'database.dump'),
    ],
    { env: pgEnv(adminUrl), maxBuffer: 16 * 1024 * 1024 },
  );
  const check = new pg.Client({ connectionString: adminUrl });
  await check.connect();
  try {
    for (const role of standIns) {
      const ident = pg.escapeIdentifier(role);
      await check.query(`REASSIGN OWNED BY ${ident} TO CURRENT_USER`);
      await check.query(`DROP OWNED BY ${ident}`);
      await check.query(`DROP ROLE ${ident}`);
    }
    const migrations = await check.query<{ tag: string }>(
      'SELECT tag FROM schema_migrations ORDER BY applied_at, tag',
    );
    const applied = migrations.rows.map((row) => row.tag);
    if (JSON.stringify(applied) !== JSON.stringify(manifest.migrations)) {
      throw new Error('Restored migrations differ from the backup manifest.');
    }
    const tables = await tableCounts(check);
    for (const [table, count] of Object.entries(manifest.tables)) {
      if (tables[table] !== count)
        throw new Error(`Restored row count differs for table ${table}.`);
    }
    return { manifest, durationMs: Date.now() - started, tables, rolesMapped: standIns };
  } finally {
    await check.end();
  }
}
