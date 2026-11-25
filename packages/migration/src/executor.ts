import { randomUUID } from 'node:crypto';

import type { Database } from '@bahith/db';
import { schema, withWorkspaceMember } from '@bahith/db';
import { and, eq, sql } from '@bahith/db/orm';
import type pg from 'pg';

import type { CanonicalSubscription, Entity } from './canonical';
import type { Plan } from './planner';
import { compareIds } from './planner';
import type { TelegramLinkStore } from './telegram';

/**
 * Apply mode. Writes into the NEW platform only:
 * - identities through the private auth role (`bahith_auth`), exactly as the auth service
 *   does; the users INSERT trigger creates the personal workspace and owner membership;
 * - research items and subscriptions through the application role (`bahith_app`) inside
 *   `withWorkspaceMember` / `withWorkspace`, so forced RLS and the ownership check apply;
 * - its own bookkeeping in a tool-owned `bahith_migration` schema (operator connection),
 *   never readable by the application role.
 *
 * Idempotent (keyed by entity + legacy id in the ledger, target ids pre-allocated before
 * the write), resumable (checkpoint per entity batch), reversible (every row is tagged
 * with the run id; see `rollbackRun`). Rollback is only safe BEFORE cut-over.
 */

export const LEDGER_SCHEMA = 'bahith_migration';

const LEDGER_DDL = [
  `CREATE SCHEMA IF NOT EXISTS ${LEDGER_SCHEMA}`,
  `REVOKE ALL ON SCHEMA ${LEDGER_SCHEMA} FROM PUBLIC`,
  `CREATE TABLE IF NOT EXISTS ${LEDGER_SCHEMA}.runs (
     id uuid PRIMARY KEY,
     started_at timestamptz NOT NULL DEFAULT now(),
     finished_at timestamptz,
     status text NOT NULL CHECK (status IN ('running','completed','failed','rolled_back'))
   )`,
  `CREATE TABLE IF NOT EXISTS ${LEDGER_SCHEMA}.items (
     entity text NOT NULL,
     legacy_id text NOT NULL,
     run_id uuid NOT NULL REFERENCES ${LEDGER_SCHEMA}.runs(id),
     target_id uuid NOT NULL,
     target_workspace_id uuid,
     state text NOT NULL CHECK (state IN ('pending','done','skipped','deferred')),
     reason text,
     updated_at timestamptz NOT NULL DEFAULT now(),
     PRIMARY KEY (entity, legacy_id)
   )`,
  `CREATE INDEX IF NOT EXISTS items_run_id_idx ON ${LEDGER_SCHEMA}.items (run_id)`,
  `CREATE TABLE IF NOT EXISTS ${LEDGER_SCHEMA}.checkpoints (
     run_id uuid NOT NULL REFERENCES ${LEDGER_SCHEMA}.runs(id),
     entity text NOT NULL,
     position integer NOT NULL,
     PRIMARY KEY (run_id, entity)
   )`,
  `CREATE TABLE IF NOT EXISTS ${LEDGER_SCHEMA}.telegram_links (
     telegram_user_id text PRIMARY KEY,
     user_legacy_id text NOT NULL,
     run_id uuid NOT NULL REFERENCES ${LEDGER_SCHEMA}.runs(id)
   )`,
];

export async function ensureLedger(ledger: pg.Pool): Promise<void> {
  for (const statement of LEDGER_DDL) await ledger.query(statement);
}

export interface ApplyTargets {
  /** Connection as `bahith_auth` (identity writes only). */
  authDb: Database;
  /** Connection as `bahith_app` (RLS-bound research and billing writes). */
  appDb: Database;
  /** Operator connection owning the `bahith_migration` ledger schema. */
  ledger: pg.Pool;
}

export interface ApplyOptions {
  /** Resume an interrupted run; a new run id is allocated otherwise. */
  runId?: string;
  batchSize?: number;
  /** Test hook: stop (throw) after this many writes, to exercise resumption. */
  failAfterWrites?: number;
}

export type ItemState = 'done' | 'skipped' | 'deferred';
export interface ApplySummary {
  runId: string;
  created: Record<Entity, number>;
  alreadyPresent: Record<Entity, number>;
  skipped: { entity: Entity; legacyId: string; reason: string }[];
  deferred: Record<Entity, number>;
}

interface LedgerItem {
  target_id: string;
  target_workspace_id: string | null;
  state: 'pending' | ItemState;
}

const zero = (): Record<Entity, number> => ({
  users: 0,
  subscriptions: 0,
  payments: 0,
  projects: 0,
  files: 0,
  telegramLinks: 0,
});

export class InterruptedForTest extends Error {
  constructor() {
    super('apply interrupted by failAfterWrites');
    this.name = 'InterruptedForTest';
  }
}

/** Status mapping into the new platform's `subscription_status` enum. */
function targetStatus(s: CanonicalSubscription): 'active' | 'trialing' | 'past_due' | 'canceled' {
  return s.status === 'expired' ? 'canceled' : s.status;
}

export async function applyPlan(
  plan: Plan,
  targets: ApplyTargets,
  options: ApplyOptions = {},
): Promise<ApplySummary> {
  const { authDb, appDb, ledger } = targets;
  const batchSize = options.batchSize ?? 100;
  await ensureLedger(ledger);
  const runId = options.runId ?? randomUUID();
  await ledger.query(
    `INSERT INTO ${LEDGER_SCHEMA}.runs (id, status) VALUES ($1, 'running')
     ON CONFLICT (id) DO UPDATE SET status = 'running', finished_at = NULL`,
    [runId],
  );
  const summary: ApplySummary = {
    runId,
    created: zero(),
    alreadyPresent: zero(),
    skipped: [],
    deferred: zero(),
  };
  let writes = 0;
  const countWrite = () => {
    writes += 1;
    if (options.failAfterWrites !== undefined && writes >= options.failAfterWrites) {
      throw new InterruptedForTest();
    }
  };

  const getItem = async (entity: Entity, legacyId: string): Promise<LedgerItem | undefined> =>
    (
      await ledger.query<LedgerItem>(
        `SELECT target_id, target_workspace_id, state FROM ${LEDGER_SCHEMA}.items
         WHERE entity = $1 AND legacy_id = $2`,
        [entity, legacyId],
      )
    ).rows[0];
  const reserve = async (entity: Entity, legacyId: string): Promise<LedgerItem> => {
    const existing = await getItem(entity, legacyId);
    if (existing !== undefined) return existing;
    const item: LedgerItem = {
      target_id: randomUUID(),
      target_workspace_id: null,
      state: 'pending',
    };
    await ledger.query(
      `INSERT INTO ${LEDGER_SCHEMA}.items (entity, legacy_id, run_id, target_id, state)
       VALUES ($1, $2, $3, $4, 'pending')`,
      [entity, legacyId, runId, item.target_id],
    );
    return item;
  };
  const settle = async (
    entity: Entity,
    legacyId: string,
    state: ItemState,
    reason: string | null,
    workspaceId: string | null = null,
  ) => {
    await ledger.query(
      `UPDATE ${LEDGER_SCHEMA}.items
         SET state = $3, reason = $4, target_workspace_id = coalesce($5, target_workspace_id), updated_at = now()
       WHERE entity = $1 AND legacy_id = $2`,
      [entity, legacyId, state, reason, workspaceId],
    );
    if (state === 'skipped' && reason !== null) summary.skipped.push({ entity, legacyId, reason });
    if (state === 'deferred') summary.deferred[entity] += 1;
  };
  const checkpoint = async (entity: Entity) =>
    (
      await ledger.query<{ position: number }>(
        `SELECT position FROM ${LEDGER_SCHEMA}.checkpoints WHERE run_id = $1 AND entity = $2`,
        [runId, entity],
      )
    ).rows[0]?.position ?? 0;
  const saveCheckpoint = (entity: Entity, position: number) =>
    ledger.query(
      `INSERT INTO ${LEDGER_SCHEMA}.checkpoints (run_id, entity, position) VALUES ($1, $2, $3)
       ON CONFLICT (run_id, entity) DO UPDATE SET position = excluded.position`,
      [runId, entity, position],
    );

  /** Runs `fn` over items in deterministic batches, checkpointing after each batch. */
  async function inBatches<T>(entity: Entity, items: T[], fn: (item: T) => Promise<void>) {
    const start = await checkpoint(entity);
    for (let i = start; i < items.length; i += batchSize) {
      for (const item of items.slice(i, i + batchSize)) await fn(item);
      await saveCheckpoint(entity, Math.min(i + batchSize, items.length));
    }
  }

  const userTarget = async (legacyUserId: string) => {
    const item = await getItem('users', legacyUserId);
    return item?.state === 'done' && item.target_workspace_id !== null
      ? { userId: item.target_id, workspaceId: item.target_workspace_id }
      : undefined;
  };

  try {
    // 1. Identities.
    await inBatches('users', plan.accepted.users, async (user) => {
      const item = await reserve('users', user.legacyId);
      if (item.state !== 'pending') {
        summary.alreadyPresent.users += 1;
        return;
      }
      const email = user.email ?? '';
      const [byId] = await authDb.db
        .select({ id: schema.users.id })
        .from(schema.users)
        .where(eq(schema.users.id, item.target_id));
      if (byId === undefined) {
        const [byEmail] = await authDb.db
          .select({ id: schema.users.id })
          .from(schema.users)
          .where(sql`lower(${schema.users.email}) = ${email}`);
        if (byEmail !== undefined) {
          // Someone already registered this address on the new platform. Never merge
          // automatically (account takeover risk); the owner resolves it by hand.
          await settle('users', user.legacyId, 'skipped', 'email_exists_in_target');
          return;
        }
        await authDb.db.insert(schema.users).values({
          id: item.target_id,
          email,
          // Unverified: the person proves the address again (password reset) on first login.
          emailVerified: false,
          name: user.name === '' ? (email.split('@')[0] ?? email) : user.name,
          createdAt: user.createdAt,
        });
        countWrite();
        summary.created.users += 1;
      } else {
        summary.alreadyPresent.users += 1;
      }
      const [workspace] = await appDb.withUser(item.target_id, (tx) =>
        tx
          .select({ id: schema.workspaces.id })
          .from(schema.workspaces)
          .where(
            and(
              eq(schema.workspaces.createdBy, item.target_id),
              eq(schema.workspaces.kind, 'personal'),
            ),
          ),
      );
      if (workspace === undefined) throw new Error('personal workspace missing after user insert');
      await settle('users', user.legacyId, 'done', null, workspace.id);
    });

    // 2. Research items → projects in the owner's personal workspace.
    await inBatches('projects', plan.accepted.projects, async (project) => {
      const item = await reserve('projects', project.legacyId);
      if (item.state !== 'pending') {
        summary.alreadyPresent.projects += 1;
        return;
      }
      const owner = await userTarget(project.userLegacyId);
      if (owner === undefined) {
        await settle('projects', project.legacyId, 'skipped', 'user_not_migrated');
        return;
      }
      const created = await withWorkspaceMember(
        appDb,
        owner.userId,
        owner.workspaceId,
        true,
        async (tx) => {
          const [existing] = await tx
            .select({ id: schema.projects.id })
            .from(schema.projects)
            .where(eq(schema.projects.id, item.target_id));
          if (existing !== undefined) return false;
          await tx.insert(schema.projects).values({
            id: item.target_id,
            workspaceId: owner.workspaceId,
            title: project.title,
            researchQuestion: project.researchQuestion,
            language: project.language,
            createdBy: owner.userId,
            createdAt: project.createdAt,
          });
          return true;
        },
      );
      if (created) {
        countWrite();
        summary.created.projects += 1;
      } else {
        summary.alreadyPresent.projects += 1;
      }
      await settle('projects', project.legacyId, 'done', null, owner.workspaceId);
    });

    // 3. Subscriptions: the new schema holds ONE per workspace — the latest period wins;
    //    older periods stay in the legacy export and the reconciliation report.
    const latest = new Map<string, CanonicalSubscription>();
    for (const s of plan.accepted.subscriptions) {
      const current = latest.get(s.userLegacyId);
      if (current === undefined || s.periodEnd.getTime() > current.periodEnd.getTime()) {
        latest.set(s.userLegacyId, s);
      }
    }
    const plansByCode = new Map(
      (
        await appDb.db.select({ id: schema.plans.id, code: schema.plans.code }).from(schema.plans)
      ).map((p) => [p.code, p.id]),
    );
    await inBatches('subscriptions', plan.accepted.subscriptions, async (s) => {
      const item = await reserve('subscriptions', s.legacyId);
      if (item.state !== 'pending') {
        summary.alreadyPresent.subscriptions += 1;
        return;
      }
      if (latest.get(s.userLegacyId)?.legacyId !== s.legacyId) {
        await settle('subscriptions', s.legacyId, 'skipped', 'superseded_by_later_period');
        return;
      }
      const owner = await userTarget(s.userLegacyId);
      const planId = plansByCode.get(s.planCode);
      if (owner === undefined || planId === undefined) {
        await settle(
          'subscriptions',
          s.legacyId,
          'skipped',
          owner === undefined ? 'user_not_migrated' : 'unknown_plan_code',
        );
        return;
      }
      const result = await appDb.withWorkspace(
        owner.workspaceId,
        async (tx) => {
          const [existing] = await tx
            .select({ id: schema.subscriptions.id })
            .from(schema.subscriptions)
            .where(eq(schema.subscriptions.workspaceId, owner.workspaceId));
          if (existing !== undefined) {
            return existing.id === item.target_id ? 'present' : 'occupied';
          }
          await tx.insert(schema.subscriptions).values({
            id: item.target_id,
            workspaceId: owner.workspaceId,
            planId,
            status: targetStatus(s),
            provider: 'legacy',
            providerSubscriptionId: `legacy:${s.legacyId}`,
            currentPeriodStart: s.periodStart,
            currentPeriodEnd: s.periodEnd,
          });
          return 'created';
        },
        { userId: owner.userId },
      );
      if (result === 'occupied') {
        await settle('subscriptions', s.legacyId, 'skipped', 'workspace_has_subscription');
        return;
      }
      if (result === 'created') {
        countWrite();
        summary.created.subscriptions += 1;
      } else {
        summary.alreadyPresent.subscriptions += 1;
      }
      await settle('subscriptions', s.legacyId, 'done', null, owner.workspaceId);
    });

    // 4. No target tables yet (see docs/runbooks/legacy-migration.md): payments and file
    //    references are recorded as deferred; Telegram links go to the ledger lookup.
    for (const entity of ['payments', 'files'] as const) {
      const rows: { legacyId: string }[] = plan.accepted[entity];
      await inBatches(entity, rows, async (row) => {
        const item = await reserve(entity, row.legacyId);
        if (item.state === 'pending')
          await settle(entity, row.legacyId, 'deferred', 'no_target_table');
      });
    }
    await inBatches('telegramLinks', plan.accepted.telegramLinks, async (link) => {
      const item = await reserve('telegramLinks', link.legacyId);
      if (item.state !== 'pending') {
        summary.alreadyPresent.telegramLinks += 1;
        return;
      }
      await ledger.query(
        `INSERT INTO ${LEDGER_SCHEMA}.telegram_links (telegram_user_id, user_legacy_id, run_id)
         VALUES ($1, $2, $3) ON CONFLICT (telegram_user_id) DO NOTHING`,
        [link.telegramUserId, link.userLegacyId, runId],
      );
      summary.created.telegramLinks += 1;
      await settle('telegramLinks', link.legacyId, 'done', null);
    });

    await ledger.query(
      `UPDATE ${LEDGER_SCHEMA}.runs SET status = 'completed', finished_at = now() WHERE id = $1`,
      [runId],
    );
  } catch (error) {
    await ledger.query(`UPDATE ${LEDGER_SCHEMA}.runs SET status = 'failed' WHERE id = $1`, [runId]);
    throw error;
  }
  summary.skipped.sort((a, b) =>
    a.entity === b.entity ? compareIds(a.legacyId, b.legacyId) : a.entity < b.entity ? -1 : 1,
  );
  return summary;
}

/**
 * Reverts one run: deletes every personal workspace (cascading projects, subscriptions
 * and memberships) and every identity the run created, then forgets its ledger rows so
 * a later apply starts clean. Only safe BEFORE cut-over: afterwards users may have
 * added their own data to those workspaces.
 */
export async function rollbackRun(
  runId: string,
  targets: ApplyTargets,
): Promise<{ users: number }> {
  const { authDb, ledger } = targets;
  const users = (
    await ledger.query<{ target_id: string; target_workspace_id: string | null }>(
      `SELECT target_id, target_workspace_id FROM ${LEDGER_SCHEMA}.items
       WHERE run_id = $1 AND entity = 'users' AND state IN ('done','pending')`,
      [runId],
    )
  ).rows;
  for (const user of users) {
    if (user.target_workspace_id === null) {
      // Interrupted between the identity insert and the ledger update.
      const [workspace] = await targets.appDb.withUser(user.target_id, (tx) =>
        tx
          .select({ id: schema.workspaces.id })
          .from(schema.workspaces)
          .where(eq(schema.workspaces.createdBy, user.target_id)),
      );
      user.target_workspace_id = workspace?.id ?? null;
    }
    if (user.target_workspace_id !== null) {
      const client = await ledger.connect();
      try {
        await client.query('BEGIN');
        // Forced RLS applies to the table owner too: bind the transaction to the workspace.
        await client.query(`SELECT set_config('app.workspace_id', $1, true)`, [
          user.target_workspace_id,
        ]);
        await client.query(
          `DELETE FROM public.workspaces WHERE id = $1 AND kind = 'personal' AND created_by = $2`,
          [user.target_workspace_id, user.target_id],
        );
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    }
    await authDb.db.delete(schema.users).where(eq(schema.users.id, user.target_id));
  }
  await ledger.query(`DELETE FROM ${LEDGER_SCHEMA}.telegram_links WHERE run_id = $1`, [runId]);
  await ledger.query(`DELETE FROM ${LEDGER_SCHEMA}.checkpoints WHERE run_id = $1`, [runId]);
  await ledger.query(`DELETE FROM ${LEDGER_SCHEMA}.items WHERE run_id = $1`, [runId]);
  await ledger.query(
    `UPDATE ${LEDGER_SCHEMA}.runs SET status = 'rolled_back', finished_at = now() WHERE id = $1`,
    [runId],
  );
  return { users: users.length };
}

/** Telegram link lookup backed by the ledger (until the app schema has its own column). */
export class LedgerTelegramLinkStore implements TelegramLinkStore {
  constructor(private readonly ledger: pg.Pool) {}

  async findUserIdByTelegramId(telegramUserId: string): Promise<string | null> {
    const result = await this.ledger.query<{ target_id: string }>(
      `SELECT i.target_id FROM ${LEDGER_SCHEMA}.telegram_links t
       JOIN ${LEDGER_SCHEMA}.items i ON i.entity = 'users' AND i.legacy_id = t.user_legacy_id
       WHERE t.telegram_user_id = $1 AND i.state = 'done'`,
      [telegramUserId],
    );
    return result.rows[0]?.target_id ?? null;
  }
}
