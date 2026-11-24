import { createDatabase, schema } from '@bahith/db';
import type { Database } from '@bahith/db';
import { eq } from '@bahith/db/orm';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { inject } from 'vitest';

import type { Plan } from '../../src/index';
import {
  applyPlan,
  buildReport,
  dryRun,
  JsonDumpSource,
  LEDGER_SCHEMA,
  LedgerTelegramLinkStore,
  linkTelegramAccount,
  PostgresLegacySource,
  reportToMarkdown,
  rollbackRun,
} from '../../src/index';
import { InterruptedForTest } from '../../src/executor';
import { assumedMapping, GENERATED_AT, legacyDump } from '../fixtures';

const meta = { generatedAt: GENERATED_AT, sourceKind: 'postgres', mode: 'dry-run' as const };

let authDb: Database;
let appDb: Database;
let ledger: pg.Pool;
let admin: pg.Pool;

beforeAll(() => {
  authDb = createDatabase({ connectionString: inject('authUrl') });
  appDb = createDatabase({ connectionString: inject('appUrl') });
  // Operator connection that owns the tool's ledger schema (superuser in the container).
  ledger = new pg.Pool({ connectionString: inject('adminUrl'), max: 2 });
  admin = new pg.Pool({ connectionString: inject('adminUrl'), max: 1 });
});

afterAll(async () => {
  await Promise.all([authDb.close(), appDb.close(), ledger.end(), admin.end()]);
});

async function postgresPlan(batchSize = 3): Promise<Plan> {
  const source = new PostgresLegacySource({
    connectionString: inject('legacyReaderUrl'),
    mapping: assumedMapping,
    batchSize,
  });
  try {
    return await dryRun(source, assumedMapping);
  } finally {
    await source.close();
  }
}

/** Row counts the migration may touch, read as superuser (bypasses RLS). */
async function targetCounts() {
  const q = async (sql: string) => Number((await admin.query<{ n: string }>(sql)).rows[0]?.n);
  return {
    users: await q('SELECT count(*) AS n FROM users'),
    workspaces: await q('SELECT count(*) AS n FROM workspaces'),
    projects: await q('SELECT count(*) AS n FROM projects'),
    subscriptions: await q('SELECT count(*) AS n FROM subscriptions'),
  };
}

describe('dry run against a synthetic legacy Postgres (ASSUMED schema)', () => {
  it('reads through a read-only session and produces the same report as the JSON dump', async () => {
    const fromPostgres = buildReport(await postgresPlan(), meta);
    const fromJson = buildReport(
      await dryRun(new JsonDumpSource(legacyDump, assumedMapping), assumedMapping),
      meta,
    );
    expect(fromPostgres).toEqual(fromJson);
    expect(reportToMarkdown(fromPostgres)).toMatchSnapshot();
  });

  it('cannot write to the legacy database even with a privileged account', async () => {
    // The source forces default_transaction_read_only; prove the server enforces it.
    const pool = new pg.Pool({
      connectionString: inject('legacyAdminUrl'),
      options: '-c default_transaction_read_only=on',
    });
    try {
      await expect(pool.query(`UPDATE legacy.members SET full_name = 'x'`)).rejects.toThrow(
        /read-only transaction/,
      );
    } finally {
      await pool.end();
    }
  });

  it('delta sync reads only rows changed since a date', async () => {
    const source = new PostgresLegacySource({
      connectionString: inject('legacyReaderUrl'),
      mapping: assumedMapping,
    });
    try {
      const rows: unknown[] = [];
      for await (const row of source.read('users', { since: new Date('2030-01-01') }))
        rows.push(row);
      expect(rows).toEqual([]);
    } finally {
      await source.close();
    }
  });
});

describe('apply into a fresh BAHITH database (test-only)', () => {
  it('applies accepted rows through the auth and app roles, idempotently and resumably', async () => {
    const plan = await postgresPlan();
    const before = await targetCounts();

    // Interrupted run: stops after two writes; resuming the same run completes it.
    const runId = crypto.randomUUID();
    await expect(
      applyPlan(plan, { authDb, appDb, ledger }, { runId, failAfterWrites: 2, batchSize: 1 }),
    ).rejects.toBeInstanceOf(InterruptedForTest);
    const resumed = await applyPlan(plan, { authDb, appDb, ledger }, { runId, batchSize: 1 });
    expect(resumed.runId).toBe(runId);

    const after = await targetCounts();
    expect(after.users - before.users).toBe(3); // legacy users 1, 9, 10
    expect(after.workspaces - before.workspaces).toBe(3); // personal workspaces via trigger
    expect(after.projects - before.projects).toBe(3); // research items 1, 2 (→ user 1), 5
    expect(after.subscriptions - before.subscriptions).toBe(2); // latest per user: 2 (pro), 5 (free)
    expect(resumed.skipped).toEqual([
      { entity: 'subscriptions', legacyId: '1', reason: 'superseded_by_later_period' },
    ]);
    expect(resumed.deferred).toMatchObject({ payments: 6, files: 2 });

    // Re-run with a NEW run id is a no-op.
    const again = await applyPlan(plan, { authDb, appDb, ledger });
    expect(again.created).toEqual({
      users: 0,
      subscriptions: 0,
      payments: 0,
      projects: 0,
      files: 0,
      telegramLinks: 0,
    });
    expect(await targetCounts()).toEqual(after);

    // Migrated identities are unverified; projects live in the owner's workspace (RLS read).
    const items = await ledger.query<{
      legacy_id: string;
      target_id: string;
      target_workspace_id: string;
    }>(
      `SELECT legacy_id, target_id, target_workspace_id FROM ${LEDGER_SCHEMA}.items WHERE entity = 'users' ORDER BY legacy_id`,
    );
    const user1 = items.rows.find((r) => r.legacy_id === '1');
    if (user1 === undefined) throw new Error('user 1 not migrated');
    const [identity] = await authDb.db
      .select()
      .from(schema.users)
      .where(eq(schema.users.id, user1.target_id));
    expect(identity).toMatchObject({ email: 'amal@example.test', emailVerified: false });
    const projects = await appDb.withWorkspace(user1.target_workspace_id, (tx) =>
      tx.select({ title: schema.projects.title }).from(schema.projects),
    );
    expect(projects.map((p) => p.title).sort()).toEqual(['Research one', 'Research two']);

    // Telegram link → migrated user, without any Telegram API call.
    const store = new LedgerTelegramLinkStore(ledger);
    const verified = { telegramUserId: '222', authDate: new Date(), source: 'web_app' as const };
    expect(await linkTelegramAccount(verified, store)).toEqual({
      status: 'linked',
      userId: user1.target_id,
      telegramUserId: '222',
    });
    expect((await linkTelegramAccount({ ...verified, telegramUserId: '333' }, store)).status).toBe(
      'not_migrated',
    );

    // The application role cannot read the ledger.
    await expect(
      appDb.withUser(user1.target_id, (tx) => tx.execute(`SELECT 1 FROM ${LEDGER_SCHEMA}.items`)),
    ).rejects.toThrow();

    // Rollback removes exactly what the runs created.
    await rollbackRun(runId, { authDb, appDb, ledger });
    await rollbackRun(again.runId, { authDb, appDb, ledger });
    expect(await targetCounts()).toEqual(before);
  });

  it('never merges into an identity that already exists on the new platform', async () => {
    const plan = await postgresPlan();
    const [existing] = await authDb.db
      .insert(schema.users)
      .values({ email: 'fahd@example.test', name: 'Registered already' })
      .returning({ id: schema.users.id });
    const summary = await applyPlan(plan, { authDb, appDb, ledger });
    expect(summary.skipped).toContainEqual({
      entity: 'users',
      legacyId: '10',
      reason: 'email_exists_in_target',
    });
    expect(summary.skipped).toContainEqual({
      entity: 'subscriptions',
      legacyId: '5',
      reason: 'user_not_migrated',
    });
    await rollbackRun(summary.runId, { authDb, appDb, ledger });
    // The pre-existing identity is untouched by rollback.
    const [still] = await authDb.db
      .select({ id: schema.users.id })
      .from(schema.users)
      .where(eq(schema.users.id, existing?.id ?? ''));
    expect(still).toBeDefined();
  });
});
