import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type pg from 'pg';
import { z } from 'zod';

import { DbError } from './errors';

/**
 * Migration runner.
 *
 * `drizzle-kit generate` writes the forward SQL and the journal in ./migrations.
 * Drizzle has no down migrations, so this runner adds them: every migration
 * `NNNN_name.sql` has a hand-written `down/NNNN_name.sql`, and `rollbackLast`
 * applies it. Each migration (up or down) runs in its own transaction.
 */

export const MIGRATIONS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../migrations',
);

const journalSchema = z.object({
  entries: z.array(z.object({ idx: z.number().int(), tag: z.string().min(1) })),
});

const BREAKPOINT = /-->\s*statement-breakpoint/g;

export interface Migration {
  tag: string;
  upSql: string;
  downSql: string;
  /** SHA-256 of the up SQL; detects edits to an already-applied migration. */
  checksum: string;
}

export async function loadMigrations(dir: string = MIGRATIONS_DIR): Promise<Migration[]> {
  const journal = journalSchema.parse(
    JSON.parse(await readFile(path.join(dir, 'meta', '_journal.json'), 'utf8')),
  );
  const entries = [...journal.entries].sort((a, b) => a.idx - b.idx);

  return Promise.all(
    entries.map(async ({ tag }) => {
      const upSql = await readFile(path.join(dir, `${tag}.sql`), 'utf8');
      let downSql: string;
      try {
        downSql = await readFile(path.join(dir, 'down', `${tag}.sql`), 'utf8');
      } catch (cause) {
        throw new DbError(
          'DB_MIGRATION_MISSING_DOWN',
          `Migration ${tag} has no down migration (expected migrations/down/${tag}.sql).`,
          { cause },
        );
      }
      return {
        tag,
        upSql: upSql.replace(BREAKPOINT, ''),
        downSql: downSql.replace(BREAKPOINT, ''),
        checksum: createHash('sha256').update(upSql).digest('hex'),
      };
    }),
  );
}

const appliedRowSchema = z.object({ tag: z.string(), checksum: z.string() });

async function ensureMigrationsTable(client: pg.ClientBase): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS public.schema_migrations (
      tag text PRIMARY KEY,
      checksum text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`);
}

async function readApplied(client: pg.ClientBase): Promise<Map<string, string>> {
  const result = await client.query('SELECT tag, checksum FROM public.schema_migrations');
  const rows = z.array(appliedRowSchema).parse(result.rows);
  return new Map(rows.map((row) => [row.tag, row.checksum]));
}

async function inTransaction(client: pg.ClientBase, fn: () => Promise<void>): Promise<void> {
  await client.query('BEGIN');
  try {
    await fn();
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

/**
 * Applies every pending migration, in order. Must run as the owner/admin role.
 * Returns the tags that were applied by this call.
 */
export async function migrateUp(
  client: pg.ClientBase,
  migrations?: Migration[],
): Promise<string[]> {
  const all = migrations ?? (await loadMigrations());
  await ensureMigrationsTable(client);
  const applied = await readApplied(client);

  const known = new Set(all.map((m) => m.tag));
  for (const tag of applied.keys()) {
    if (!known.has(tag)) {
      throw new DbError(
        'DB_MIGRATION_UNKNOWN',
        `The database has migration ${tag}, which is unknown to this code version.`,
      );
    }
  }

  const done: string[] = [];
  for (const migration of all) {
    const appliedChecksum = applied.get(migration.tag);
    if (appliedChecksum !== undefined) {
      if (appliedChecksum !== migration.checksum) {
        throw new DbError(
          'DB_MIGRATION_CHECKSUM_MISMATCH',
          `Migration ${migration.tag} was modified after it was applied. Add a new migration instead.`,
        );
      }
      continue;
    }
    await inTransaction(client, async () => {
      await client.query(migration.upSql);
      await client.query('INSERT INTO public.schema_migrations (tag, checksum) VALUES ($1, $2)', [
        migration.tag,
        migration.checksum,
      ]);
    });
    done.push(migration.tag);
  }
  return done;
}

/**
 * Reverts the most recently applied migration(s) using their down SQL.
 * Returns the tags that were reverted, most recent first.
 */
export async function rollbackLast(
  client: pg.ClientBase,
  steps = 1,
  migrations?: Migration[],
): Promise<string[]> {
  const all = migrations ?? (await loadMigrations());
  await ensureMigrationsTable(client);
  const applied = await readApplied(client);

  const toRevert = all
    .filter((m) => applied.has(m.tag))
    .reverse()
    .slice(0, steps);

  const reverted: string[] = [];
  for (const migration of toRevert) {
    await inTransaction(client, async () => {
      await client.query(migration.downSql);
      await client.query('DELETE FROM public.schema_migrations WHERE tag = $1', [migration.tag]);
    });
    reverted.push(migration.tag);
  }
  return reverted;
}
