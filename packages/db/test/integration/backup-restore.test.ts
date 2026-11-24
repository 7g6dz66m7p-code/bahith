import { performance } from 'node:perf_hooks';

import { PostgreSqlContainer } from '@testcontainers/postgresql';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { sql } from 'drizzle-orm';
import pg from 'pg';
import { expect, it } from 'vitest';
import { z } from 'zod';

import { createDatabase } from '../../src/client';
import { migrateUp } from '../../src/migrator';
import { provisionAppRole, provisionAuthRole } from '../../src/provision';
import { POSTGRES_IMAGE, startTestDatabase } from '../../src/testing';

/** A real logical backup, restored into another cluster, with synthetic data only. */
it('restores roles, private identities, research data, migrations and isolation into a fresh cluster', async () => {
  const startedAt = performance.now();
  const source = await startTestDatabase();
  let target: StartedPostgreSqlContainer | undefined;
  const admin = new pg.Client({ connectionString: source.adminUrl });
  const users: { id: string; workspaceId: string; projectId: string }[] = [];
  const rows = z.object({ id: z.uuid() });
  try {
    await admin.connect();
    for (const label of ['A', 'B']) {
      const userId = rows.parse(
        (
          await admin.query(
            'INSERT INTO users (email, name, email_verified) VALUES ($1, $2, true) RETURNING id',
            [`restore-${crypto.randomUUID()}@example.test`, `Synthetic ${label}`],
          )
        ).rows[0],
      ).id;
      const workspaceId = rows.parse(
        (await admin.query('SELECT id FROM workspaces WHERE created_by = $1', [userId])).rows[0],
      ).id;
      const projectId = rows.parse(
        (
          await admin.query(
            'INSERT INTO projects (workspace_id, title, created_by) VALUES ($1, $2, $3) RETURNING id',
            [workspaceId, `Synthetic research ${label}`, userId],
          )
        ).rows[0],
      ).id;
      await admin.query(
        "INSERT INTO sessions (user_id, token, expires_at) VALUES ($1, $2, now() + interval '1 day')",
        [userId, crypto.randomUUID()],
      );
      const sourceId = rows.parse(
        (
          await admin.query(
            "INSERT INTO sources (workspace_id, origin, type, title) VALUES ($1, 'upload', 'article-journal', $2) RETURNING id",
            [workspaceId, `Synthetic source ${label}`],
          )
        ).rows[0],
      ).id;
      const fileId = rows.parse(
        (
          await admin.query(
            "INSERT INTO files (workspace_id, source_id, storage_key, original_name, mime_type, size_bytes, status) VALUES ($1, $2, $3, 'fixture.pdf', 'application/pdf', 32, 'ready') RETURNING id",
            [workspaceId, sourceId, `${workspaceId}/${crypto.randomUUID()}.pdf`],
          )
        ).rows[0],
      ).id;
      await admin.query(
        'INSERT INTO chunks (workspace_id, source_id, file_id, chunk_index, page_start, page_end, content) VALUES ($1, $2, $3, 0, 1, 1, $4)',
        [workspaceId, sourceId, fileId, `نص عربي اصطناعي للاختبار ${label}`],
      );
      users.push({ id: userId, workspaceId, projectId });
    }
    const migrations = (
      await admin.query('SELECT tag, checksum FROM schema_migrations ORDER BY tag')
    ).rows;
    const chunkRows = (
      await admin.query(
        'SELECT id, workspace_id, source_id, file_id, page_start, page_end, content, tsv::text FROM chunks ORDER BY id',
      )
    ).rows;
    const policies = (
      await admin.query('SELECT * FROM pg_policies ORDER BY schemaname, tablename, policyname')
    ).rows;

    // No role password hashes are copied. Fresh credentials are provisioned after restore.
    const roles = await source.container.exec([
      'pg_dumpall',
      '-U',
      source.container.getUsername(),
      '--roles-only',
      '--no-role-passwords',
    ]);
    expect(roles.exitCode).toBe(0);
    const dump = await source.container.exec([
      'pg_dump',
      '-U',
      source.container.getUsername(),
      '-d',
      source.container.getDatabase(),
    ]);
    expect(dump.exitCode).toBe(0);
    // Distinct bootstrap role avoids a collision with the source cluster's owner role.
    target = await new PostgreSqlContainer(POSTGRES_IMAGE)
      .withUsername('restore_admin')
      .withPassword(crypto.randomUUID())
      .withDatabase('restored')
      .start();
    await target.copyContentToContainer([
      { content: roles.stdout, target: '/tmp/roles.sql' },
      { content: dump.stdout, target: '/tmp/database.sql' },
    ]);
    for (const file of ['/tmp/roles.sql', '/tmp/database.sql']) {
      const restored = await target.exec([
        'psql',
        '-U',
        'restore_admin',
        '-d',
        'restored',
        '-v',
        'ON_ERROR_STOP=1',
        '-f',
        file,
      ]);
      expect(restored.exitCode).toBe(0);
    }

    const restoredAdmin = new pg.Client({ connectionString: target.getConnectionUri() });
    await restoredAdmin.connect();
    const password = crypto.randomUUID();
    const authPassword = crypto.randomUUID();
    try {
      expect(
        (await restoredAdmin.query('SELECT tag, checksum FROM schema_migrations ORDER BY tag'))
          .rows,
      ).toEqual(migrations);
      expect(await migrateUp(restoredAdmin)).toEqual([]);
      expect(
        (
          await restoredAdmin.query(
            'SELECT id, workspace_id, source_id, file_id, page_start, page_end, content, tsv::text FROM chunks ORDER BY id',
          )
        ).rows,
      ).toEqual(chunkRows);
      expect(
        (
          await restoredAdmin.query(
            'SELECT * FROM pg_policies ORDER BY schemaname, tablename, policyname',
          )
        ).rows,
      ).toEqual(policies);
      expect(
        (await restoredAdmin.query('SELECT count(*)::int AS count FROM sessions')).rows,
      ).toEqual([{ count: 2 }]);
      expect(
        (
          await restoredAdmin.query(
            "SELECT rolname, rolsuper, rolbypassrls FROM pg_roles WHERE rolname IN ('bahith_app', 'bahith_auth', 'bahith_identity_provisioner') ORDER BY rolname",
          )
        ).rows,
      ).toEqual([
        { rolname: 'bahith_app', rolsuper: false, rolbypassrls: false },
        { rolname: 'bahith_auth', rolsuper: false, rolbypassrls: false },
        { rolname: 'bahith_identity_provisioner', rolsuper: false, rolbypassrls: false },
      ]);
      const unprotected = await restoredAdmin.query(
        "SELECT relname FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relkind = 'r' AND EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = pg_class.oid AND attname = 'workspace_id') AND NOT (relrowsecurity AND relforcerowsecurity)",
      );
      expect(unprotected.rows).toEqual([]);
      await provisionAppRole(restoredAdmin, password);
      await provisionAuthRole(restoredAdmin, authPassword);
    } finally {
      await restoredAdmin.end();
    }

    const appUrl = new URL(target.getConnectionUri());
    appUrl.username = 'bahith_app';
    appUrl.password = password;
    const authUrl = new URL(target.getConnectionUri());
    authUrl.username = 'bahith_auth';
    authUrl.password = authPassword;
    const auth = new pg.Client({ connectionString: authUrl.toString() });
    await auth.connect();
    let newUserId: string;
    try {
      newUserId = rows.parse(
        (
          await auth.query('INSERT INTO users (email, name) VALUES ($1, $2) RETURNING id', [
            `post-restore-${crypto.randomUUID()}@example.test`,
            'Synthetic restored signup',
          ])
        ).rows[0],
      ).id;
    } finally {
      await auth.end();
    }
    const app = createDatabase({ connectionString: appUrl.toString() });
    try {
      const provisioned = await app.withUser(newUserId, (tx) =>
        tx.execute(sql`SELECT id FROM workspaces`),
      );
      expect(provisioned.rows).toHaveLength(1);
      expect((await app.pool.query('SELECT id FROM projects')).rows).toEqual([]);
      for (const user of users) {
        const visible = await app.withWorkspace(
          user.workspaceId,
          (tx) => tx.execute(sql`SELECT id FROM projects`),
          { userId: user.id },
        );
        expect(visible.rows).toEqual([{ id: user.projectId }]);
      }
      await expect(app.pool.query('SELECT token FROM sessions')).rejects.toMatchObject({
        code: '42501',
      });
    } finally {
      await app.close();
    }
    process.stdout.write(
      `Isolated PostgreSQL backup/restore drill: ${Math.round(performance.now() - startedAt)} ms; two synthetic users, fresh cluster, roles and RLS verified.\n`,
    );
  } finally {
    await admin.end();
    await Promise.allSettled([source.stop(), target?.stop()]);
  }
}, 120_000);
