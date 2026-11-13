import { PostgreSqlContainer } from '@testcontainers/postgresql';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { loadMigrations, migrateUp, rollbackLast } from '../../src/migrator';
import { POSTGRES_IMAGE } from '../../src/testing';

/**
 * Every migration must have a working down migration (engineering policy, section 10).
 * Runs in its own container because the last down migration drops the cluster-wide
 * application role.
 */

const names = z.array(z.object({ name: z.string() }));

async function listNames(client: pg.Client, query: string): Promise<string[]> {
  return names.parse((await client.query(query)).rows).map((row) => row.name);
}

const TABLES = `SELECT tablename AS name FROM pg_tables WHERE schemaname = 'public' ORDER BY 1`;
const ENUMS = `SELECT t.typname AS name FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
               WHERE n.nspname = 'public' AND t.typtype = 'e' ORDER BY 1`;
const POLICIES = `SELECT policyname AS name FROM pg_policies WHERE schemaname = 'public' ORDER BY 1`;
const EXTENSIONS = `SELECT extname AS name FROM pg_extension WHERE extname = 'vector'`;
const SCHEMAS = `SELECT nspname AS name FROM pg_namespace WHERE nspname = 'app'`;
const ROLES = `SELECT rolname AS name FROM pg_roles WHERE rolname = 'bahith_app'`;

describe('migrations', () => {
  let container: StartedPostgreSqlContainer;
  let client: pg.Client;

  beforeAll(async () => {
    container = await new PostgreSqlContainer(POSTGRES_IMAGE).start();
    client = new pg.Client({ connectionString: container.getConnectionUri() });
    await client.connect();
  });

  afterAll(async () => {
    await client.end();
    await container.stop();
  });

  it('applies every migration on an empty database', async () => {
    const all = await loadMigrations();
    expect(await migrateUp(client)).toEqual(all.map((m) => m.tag));

    expect(await listNames(client, TABLES)).toHaveLength(23 + 1); // + schema_migrations
    expect(await listNames(client, EXTENSIONS)).toEqual(['vector']);
    expect(await listNames(client, ROLES)).toEqual(['bahith_app']);
  });

  it('is idempotent: a second run applies nothing', async () => {
    expect(await migrateUp(client)).toEqual([]);
  });

  it('creates the HNSW and GIN indexes on chunks', async () => {
    const result = await client.query(
      `SELECT indexname, indexdef FROM pg_indexes
       WHERE tablename = 'chunks' AND indexname IN ('chunks_embedding_hnsw', 'chunks_tsv_gin')
       ORDER BY indexname`,
    );
    const rows = z
      .array(z.object({ indexname: z.string(), indexdef: z.string() }))
      .parse(result.rows);
    expect(rows.map((row) => row.indexname)).toEqual(['chunks_embedding_hnsw', 'chunks_tsv_gin']);
    expect(rows[0]?.indexdef).toMatch(/USING hnsw \(embedding vector_cosine_ops\)/);
    expect(rows[1]?.indexdef).toMatch(/USING gin \(tsv\)/);
  });

  it('refuses to run when an applied migration was edited afterwards', async () => {
    const all = await loadMigrations();
    const tampered = all.map((m, i) => (i === 0 ? { ...m, checksum: 'different' } : m));
    await expect(migrateUp(client, tampered)).rejects.toMatchObject({
      code: 'DB_MIGRATION_CHECKSUM_MISMATCH',
    });
  });

  it('refuses to run against a database that is ahead of the code', async () => {
    const all = await loadMigrations();
    await expect(migrateUp(client, all.slice(0, -1))).rejects.toMatchObject({
      code: 'DB_MIGRATION_UNKNOWN',
    });
  });

  it('rolls back one migration at a time, most recent first', async () => {
    expect(await rollbackLast(client)).toEqual(['0002_security']);
    expect(await listNames(client, ROLES)).toEqual([]);
    // Tables are still there after reverting only the security migration.
    expect(await listNames(client, TABLES)).toHaveLength(23 + 1);
    expect(await migrateUp(client)).toEqual(['0002_security']);
  });

  it('rolls everything back to an empty database, then applies it all again', async () => {
    const all = await loadMigrations();
    const reverted = await rollbackLast(client, all.length);
    expect(reverted).toEqual(all.map((m) => m.tag).reverse());

    expect(await listNames(client, TABLES)).toEqual(['schema_migrations']);
    expect(await listNames(client, ENUMS)).toEqual([]);
    expect(await listNames(client, POLICIES)).toEqual([]);
    expect(await listNames(client, EXTENSIONS)).toEqual([]);
    expect(await listNames(client, SCHEMAS)).toEqual([]);
    expect(await listNames(client, ROLES)).toEqual([]);
    expect(await rollbackLast(client)).toEqual([]);

    expect(await migrateUp(client)).toEqual(all.map((m) => m.tag));
    expect(await listNames(client, TABLES)).toHaveLength(23 + 1);
  });
});
