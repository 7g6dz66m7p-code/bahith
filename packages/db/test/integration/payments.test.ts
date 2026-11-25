import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { z } from 'zod';

import type { Database } from '../../src/index';
import {
  applyVerifiedPaymentEvent,
  attachProviderPaymentId,
  createDatabase,
  createPendingPayment,
  getWorkspaceUsage,
  listPaymentsForReconciliation,
  PaymentError,
  reconcilePayments,
} from '../../src/index';
import { seedReferenceData } from '../../src/seed';

import type { WorkspaceFixture } from './fixtures';
import { seedWorkspace } from './fixtures';

/**
 * Test-only plans: currency XTS is the ISO 4217 code reserved for testing, and the
 * amounts are arbitrary fixtures — never real prices.
 */
const PROVIDER = 'testpay';
const DAY = 86_400_000;

describe('payments and subscription activation', () => {
  let database: Database;
  let admin: pg.Client;
  let a: WorkspaceFixture;
  let b: WorkspaceFixture;
  let paidPlan: string;
  let unpricedPlan: string;

  beforeAll(async () => {
    database = createDatabase({ connectionString: inject('appUrl') });
    admin = new pg.Client({ connectionString: inject('adminUrl') });
    await admin.connect();
    await seedReferenceData(admin);
    paidPlan = `paid-${crypto.randomUUID().slice(0, 8)}`;
    unpricedPlan = `unpriced-${crypto.randomUUID().slice(0, 8)}`;
    await admin.query(
      `INSERT INTO plans (code, name, limits, price_minor, currency, period_days)
       VALUES ($1, 'Paid', '{"ai_requests_per_month": 500}', 1234, 'XTS', 30)`,
      [paidPlan],
    );
    const unpriced = z
      .object({ id: z.string() })
      .parse(
        (
          await admin.query(
            `INSERT INTO plans (code, name, limits) VALUES ($1, 'Unpriced', '{}') RETURNING id`,
            [unpricedPlan],
          )
        ).rows[0],
      );
    a = await seedWorkspace(database, 'PayA', unpriced.id);
    b = await seedWorkspace(database, 'PayB', unpriced.id);
  });

  afterAll(async () => {
    await database.close();
    await admin.end();
  });

  const pending = (workspace: WorkspaceFixture, userId = workspace.userId) =>
    createPendingPayment(database, {
      userId,
      workspaceId: workspace.workspaceId,
      planCode: paidPlan,
      provider: PROVIDER,
    });

  const event = (
    workspace: WorkspaceFixture,
    paymentId: string,
    kind: 'succeeded' | 'failed' | 'refunded',
    overrides: Partial<{ amountMinor: number; currency: string; eventId: string; at: Date }> = {},
  ) =>
    applyVerifiedPaymentEvent(database, {
      provider: PROVIDER,
      eventId: overrides.eventId ?? crypto.randomUUID(),
      workspaceId: workspace.workspaceId,
      paymentId,
      kind,
      amountMinor: overrides.amountMinor ?? 1234,
      currency: overrides.currency ?? 'XTS',
      occurredAt: overrides.at ?? new Date(),
    });

  const subscription = async (workspace: WorkspaceFixture) =>
    z.object({ code: z.string(), status: z.string(), end: z.date().nullable() }).parse(
      (
        await admin.query(
          `SELECT p.code, s.status, s.current_period_end AS end
             FROM subscriptions s JOIN plans p ON p.id = s.plan_id WHERE s.workspace_id = $1`,
          [workspace.workspaceId],
        )
      ).rows[0],
    );

  it('only the owner can start a payment, and only for a priced plan', async () => {
    await expect(
      createPendingPayment(database, {
        userId: a.userId,
        workspaceId: a.workspaceId,
        planCode: unpricedPlan,
        provider: PROVIDER,
      }),
    ).rejects.toEqual(new PaymentError('PAYMENT_PLAN_NOT_PURCHASABLE'));
    await expect(pending(a, b.userId)).rejects.toEqual(new PaymentError('PAYMENT_FORBIDDEN'));
    const created = await pending(a);
    // The amount comes from the stored plan, never from the request.
    expect(created).toMatchObject({ amountMinor: 1234, currency: 'XTS', periodDays: 30 });
  });

  it('a verified success activates once; duplicates and replays change nothing', async () => {
    const payment = await pending(a);
    await attachProviderPaymentId(database, a.workspaceId, payment.id, `pp-${payment.id}`);
    const paidAt = new Date();
    const eventId = `evt-${payment.id}`;
    expect(await event(a, payment.id, 'succeeded', { eventId, at: paidAt })).toEqual({
      status: 'applied',
      paymentStatus: 'succeeded',
    });
    const active = await subscription(a);
    expect(active).toMatchObject({ code: paidPlan, status: 'active' });
    expect(active.end?.getTime()).toBe(paidAt.getTime() + 30 * DAY);

    expect(await event(a, payment.id, 'succeeded', { eventId, at: paidAt })).toEqual({
      status: 'duplicate',
    });
    expect(await event(a, payment.id, 'succeeded')).toEqual({
      status: 'ignored',
      paymentStatus: 'succeeded',
    });
    expect((await subscription(a)).end?.getTime()).toBe(paidAt.getTime() + 30 * DAY);
    const usage = await getWorkspaceUsage(database, {
      userId: a.userId,
      workspaceId: a.workspaceId,
    });
    expect(usage.plan?.code).toBe(paidPlan);
    expect(usage.aiRequests.limit).toBe(500);
  });

  it('a second paid period extends from the end of the running one', async () => {
    const before = (await subscription(a)).end;
    const payment = await pending(a);
    await event(a, payment.id, 'succeeded');
    expect((await subscription(a)).end?.getTime()).toBe((before?.getTime() ?? 0) + 30 * DAY);
  });

  it('a different amount or currency is recorded as a mismatch and activates nothing', async () => {
    const payment = await pending(b);
    expect(await event(b, payment.id, 'succeeded', { amountMinor: 1 })).toMatchObject({
      status: 'mismatch',
    });
    expect(await event(b, payment.id, 'succeeded', { currency: 'USD' })).toMatchObject({
      status: 'mismatch',
    });
    expect((await subscription(b)).code).not.toBe(paidPlan);
    const stored = await admin.query<{ status: string }>(
      'SELECT status FROM payments WHERE id = $1',
      [payment.id],
    );
    expect(stored.rows[0]?.status).toBe('pending');
  });

  it('an event naming another workspace cannot reach a payment (RLS)', async () => {
    const payment = await pending(a);
    await expect(event(b, payment.id, 'succeeded')).rejects.toEqual(
      new PaymentError('PAYMENT_NOT_FOUND'),
    );
  });

  it('failures only move pending payments; a refund of the only payment ends the plan', async () => {
    const failed = await pending(b);
    expect(await event(b, failed.id, 'failed')).toEqual({
      status: 'applied',
      paymentStatus: 'failed',
    });
    const paid = await pending(b);
    await event(b, paid.id, 'succeeded');
    expect((await subscription(b)).status).toBe('active');
    expect(await event(b, paid.id, 'refunded')).toEqual({
      status: 'applied',
      paymentStatus: 'refunded',
    });
    expect((await subscription(b)).status).toBe('canceled');
    const usage = await getWorkspaceUsage(database, {
      userId: b.userId,
      workspaceId: b.workspaceId,
    });
    expect(usage.plan?.code).toBe('free');
  });

  it('an ended paid period no longer grants the plan', async () => {
    await admin.query(
      `UPDATE subscriptions SET current_period_end = now() - interval '1 day' WHERE workspace_id = $1`,
      [a.workspaceId],
    );
    const usage = await getWorkspaceUsage(database, {
      userId: a.userId,
      workspaceId: a.workspaceId,
    });
    expect(usage.plan?.code).toBe('free');
  });

  it('reconciliation reports differences with the provider and changes nothing', async () => {
    const local = await listPaymentsForReconciliation(database, a.workspaceId);
    expect(local).toHaveLength(1);
    const [record] = local;
    if (record === undefined) throw new Error('expected a provider-linked payment');
    const report = reconcilePayments(local, [
      { ...record, status: 'refunded' },
      {
        providerPaymentId: 'unknown-at-bahith',
        status: 'succeeded',
        amountMinor: 5,
        currency: 'XTS',
      },
    ]);
    expect(report).toEqual({
      matched: 0,
      missingLocally: ['unknown-at-bahith'],
      missingAtProvider: [],
      amountMismatch: [],
      statusMismatch: [record.providerPaymentId],
    });
    expect(reconcilePayments(local, [record]).matched).toBe(1);
    expect(reconcilePayments(local, []).missingAtProvider).toEqual([record.providerPaymentId]);
    expect(
      reconcilePayments(local, [{ ...record, amountMinor: record.amountMinor + 1 }]).amountMismatch,
    ).toEqual([record.providerPaymentId]);
  });

  it('the application role cannot delete payments or rewrite events', async () => {
    const payment = await pending(a);
    await expect(
      database.withWorkspace(a.workspaceId, (tx) =>
        tx.execute(`DELETE FROM payments WHERE id = '${payment.id}'`),
      ),
    ).rejects.toMatchObject({ cause: { code: '42501' } });
    await expect(
      database.withWorkspace(a.workspaceId, (tx) =>
        tx.execute(`UPDATE payment_events SET outcome = 'applied'`),
      ),
    ).rejects.toMatchObject({ cause: { code: '42501' } });
  });
});
