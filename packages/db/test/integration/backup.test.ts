import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { PostgreSqlContainer } from '@testcontainers/postgresql';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { z } from 'zod';

import { backupDatabase, restoreDatabase } from '../../src/backup';
import { loadMigrations } from '../../src/migrator';
import { createDatabase } from '../../src/client';
import type { Database } from '../../src/client';
import { seedReferenceData } from '../../src/seed';
import { POSTGRES_IMAGE } from '../../src/testing';

import { seedWorkspace } from './fixtures';

/**
 * Backup → restore into a brand-new Postgres server, proving what the runbook claims:
 * same migrations, same rows in every table, RLS still forced, app roles re-created
 * without passwords, and a corrupted backup is refused.
 */
describe('backup and restore', () => {
  let database: Database;
  let target: StartedPostgreSqlContainer;
  let directory: string;

  beforeAll(async () => {
    database = createDatabase({ connectionString: inject('appUrl') });
    const admin = new pg.Client({ connectionString: inject('adminUrl') });
    await admin.connect();
    await seedReferenceData(admin);
    const plan = z
      .object({ id: z.string() })
      .parse((await admin.query(`SELECT id FROM plans WHERE code = 'free'`)).rows[0]);
    await admin.end();
    // A workspace with a row in every tenant table, including Arabic research text.
    await seedWorkspace(database, 'Backup', plan.id);
    target = await new PostgreSqlContainer(POSTGRES_IMAGE).start();
    directory = await mkdtemp(path.join(os.tmpdir(), 'bahith-backup-'));
  });

  afterAll(async () => {
    await database.close();
    await target.stop();
    await rm(directory, { recursive: true, force: true });
  });

  it('restores everything into an empty server and proves it', async () => {
    const manifest = await backupDatabase(inject('adminUrl'), directory);
    expect(manifest.migrations).toEqual((await loadMigrations()).map((m) => m.tag));
    expect(Object.values(manifest.tables).reduce((a, b) => a + b, 0)).toBeGreaterThan(20);
    const roles = await readFile(path.join(directory, 'roles.sql'), 'utf8');
    expect(roles).toContain('CREATE ROLE bahith_app');
    expect(roles).not.toMatch(/PASSWORD|SCRAM|md5/iu);

    const report = await restoreDatabase(target.getConnectionUri(), directory);
    expect(report.tables).toEqual(manifest.tables);
    // Well under the two-hour objective (this database is small; see the runbook).
    expect(report.durationMs).toBeLessThan(2 * 60 * 60 * 1000);

    const check = new pg.Client({ connectionString: target.getConnectionUri() });
    await check.connect();
    try {
      const unprotected = await check.query(
        `SELECT c.relname FROM pg_class c JOIN pg_attribute a ON a.attrelid = c.oid
          WHERE c.relnamespace = 'public'::regnamespace AND c.relkind = 'r'
            AND a.attname = 'workspace_id' AND NOT (c.relrowsecurity AND c.relforcerowsecurity)`,
      );
      expect(unprotected.rows).toEqual([]);
      const app = await check.query(
        `SELECT rolbypassrls, rolsuper FROM pg_roles WHERE rolname = 'bahith_app'`,
      );
      expect(app.rows).toEqual([{ rolbypassrls: false, rolsuper: false }]);
    } finally {
      await check.end();
    }
    // A second restore into the now non-empty database is refused.
    await expect(restoreDatabase(target.getConnectionUri(), directory)).rejects.toThrow(
      /not empty/u,
    );
  });

  it('refuses a backup whose files do not match the manifest', async () => {
    const dump = path.join(directory, 'roles.sql');
    await writeFile(dump, `${await readFile(dump, 'utf8')}-- tampered\n`);
    const fresh = await new PostgreSqlContainer(POSTGRES_IMAGE).start();
    try {
      await expect(restoreDatabase(fresh.getConnectionUri(), directory)).rejects.toThrow(
        /checksum/u,
      );
    } finally {
      await fresh.stop();
    }
  });
});
