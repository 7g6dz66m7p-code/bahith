import { and, desc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';

import type { Database, Tx } from './client';
import {
  auditLog,
  memberships,
  paymentEvents,
  payments,
  plans,
  subscriptions,
} from './schema/index';

/**
 * Payments and subscription activation, provider-neutral.
 *
 * - A payment is created `pending` by the workspace owner, at the plan's stored price
 *   (prices are set by the owner; a plan without one cannot be bought).
 * - Only a provider event whose signature the caller has verified may change it. The
 *   browser's redirect after checkout never activates anything.
 * - Every event is stored once per (provider, event id): duplicates and replays return
 *   `duplicate` and change nothing.
 * - Activation requires the reported amount and currency to equal the recorded ones;
 *   anything else is stored as `mismatch` for reconciliation and activates nothing.
 */

export type PaymentErrorCode =
  | 'PAYMENT_INVALID_INPUT'
  | 'PAYMENT_FORBIDDEN'
  | 'PAYMENT_PLAN_NOT_PURCHASABLE'
  | 'PAYMENT_NOT_FOUND';

export class PaymentError extends Error {
  constructor(readonly code: PaymentErrorCode) {
    super(code);
    this.name = 'PaymentError';
  }
}

const DAY_MS = 86_400_000;
const providerSchema = z.string().regex(/^[a-z][a-z0-9_-]{1,31}$/u);
const externalIdSchema = z.string().min(1).max(255);

export interface PendingPayment {
  id: string;
  workspaceId: string;
  planCode: string;
  amountMinor: number;
  currency: string;
  periodDays: number;
}

/** Owner-only: records a pending payment for `planCode` at its stored price. */
export async function createPendingPayment(
  database: Database,
  input: { userId: string; workspaceId: string; planCode: string; provider: string },
): Promise<PendingPayment> {
  const parsed = z
    .object({
      userId: z.uuid(),
      workspaceId: z.uuid(),
      planCode: z.string().regex(/^[a-z][a-z0-9-]{0,39}$/u),
      provider: providerSchema,
    })
    .safeParse(input);
  if (!parsed.success) throw new PaymentError('PAYMENT_INVALID_INPUT');
  const { userId, workspaceId, planCode, provider } = parsed.data;
  return database.withWorkspace(
    workspaceId,
    async (tx) => {
      const [member] = await tx
        .select({ role: memberships.role })
        .from(memberships)
        .where(and(eq(memberships.workspaceId, workspaceId), eq(memberships.userId, userId)))
        .for('share');
      if (member?.role !== 'owner') throw new PaymentError('PAYMENT_FORBIDDEN');
      const [plan] = await tx
        .select({
          id: plans.id,
          priceMinor: plans.priceMinor,
          currency: plans.currency,
          periodDays: plans.periodDays,
          isActive: plans.isActive,
        })
        .from(plans)
        .where(eq(plans.code, planCode));
      if (
        plan === undefined ||
        !plan.isActive ||
        plan.priceMinor === null ||
        plan.currency === null ||
        plan.periodDays === null
      ) {
        throw new PaymentError('PAYMENT_PLAN_NOT_PURCHASABLE');
      }
      const [row] = await tx
        .insert(payments)
        .values({
          workspaceId,
          planId: plan.id,
          createdBy: userId,
          provider,
          amountMinor: plan.priceMinor,
          currency: plan.currency,
          periodDays: plan.periodDays,
        })
        .returning({ id: payments.id });
      if (row === undefined) throw new Error('PAYMENT_INSERT_FAILED');
      await audit(tx, workspaceId, userId, 'payment.created', row.id, { provider, planCode });
      return {
        id: row.id,
        workspaceId,
        planCode,
        amountMinor: plan.priceMinor,
        currency: plan.currency,
        periodDays: plan.periodDays,
      };
    },
    { userId },
  );
}

/** Stores the provider's id for a payment once its checkout has been created. */
export async function attachProviderPaymentId(
  database: Database,
  workspaceId: string,
  paymentId: string,
  providerPaymentId: string,
): Promise<void> {
  if (
    !z.uuid().safeParse(workspaceId).success ||
    !z.uuid().safeParse(paymentId).success ||
    !externalIdSchema.safeParse(providerPaymentId).success
  ) {
    throw new PaymentError('PAYMENT_INVALID_INPUT');
  }
  await database.withWorkspace(workspaceId, async (tx) => {
    const updated = await tx
      .update(payments)
      .set({ providerPaymentId })
      .where(and(eq(payments.id, paymentId), eq(payments.status, 'pending')))
      .returning({ id: payments.id });
    if (updated.length !== 1) throw new PaymentError('PAYMENT_NOT_FOUND');
  });
}

export const verifiedPaymentEventSchema = z.object({
  provider: providerSchema,
  eventId: externalIdSchema,
  /** Our own references, carried by the provider as payment metadata. */
  workspaceId: z.uuid(),
  paymentId: z.uuid(),
  kind: z.enum(['succeeded', 'failed', 'refunded']),
  amountMinor: z.number().int().positive(),
  currency: z.string().regex(/^[A-Z]{3}$/u),
  occurredAt: z.date(),
});
export type VerifiedPaymentEvent = z.infer<typeof verifiedPaymentEventSchema>;

export type PaymentEventResult =
  { status: 'duplicate' } | { status: 'applied' | 'ignored' | 'mismatch'; paymentStatus: string };

/**
 * Applies one provider event. The caller MUST have verified the provider's signature on
 * the raw request first; this function trusts the event's fields only after that.
 */
export async function applyVerifiedPaymentEvent(
  database: Database,
  input: VerifiedPaymentEvent,
): Promise<PaymentEventResult> {
  const parsed = verifiedPaymentEventSchema.safeParse(input);
  if (!parsed.success) throw new PaymentError('PAYMENT_INVALID_INPUT');
  const event = parsed.data;
  return database.withWorkspace(event.workspaceId, async (tx) => {
    const [payment] = await tx
      .select()
      .from(payments)
      .where(eq(payments.id, event.paymentId))
      .for('update');
    if (payment === undefined) throw new PaymentError('PAYMENT_NOT_FOUND');

    const matches =
      payment.provider === event.provider &&
      payment.amountMinor === event.amountMinor &&
      payment.currency === event.currency;
    let outcome: 'applied' | 'ignored' | 'mismatch';
    let next = payment.status;
    if (!matches) outcome = 'mismatch';
    else if (event.kind === 'succeeded') {
      outcome = payment.status === 'pending' || payment.status === 'failed' ? 'applied' : 'ignored';
      if (outcome === 'applied') next = 'succeeded';
    } else if (event.kind === 'failed') {
      outcome = payment.status === 'pending' ? 'applied' : 'ignored';
      if (outcome === 'applied') next = 'failed';
    } else {
      outcome = payment.status === 'succeeded' ? 'applied' : 'ignored';
      if (outcome === 'applied') next = 'refunded';
    }

    const stored = await tx
      .insert(paymentEvents)
      .values({
        workspaceId: event.workspaceId,
        paymentId: payment.id,
        provider: event.provider,
        eventId: event.eventId,
        kind: event.kind,
        amountMinor: event.amountMinor,
        currency: event.currency,
        outcome,
        occurredAt: event.occurredAt,
      })
      .onConflictDoNothing({ target: [paymentEvents.provider, paymentEvents.eventId] })
      .returning({ id: paymentEvents.id });
    if (stored.length === 0) return { status: 'duplicate' };

    if (outcome === 'applied') {
      await tx
        .update(payments)
        .set({
          status: next,
          ...(next === 'succeeded' ? { paidAt: event.occurredAt } : {}),
        })
        .where(eq(payments.id, payment.id));
      if (next === 'succeeded') await activate(tx, payment, event.occurredAt);
      if (next === 'refunded') await revoke(tx, payment, event.occurredAt);
    }
    await audit(tx, event.workspaceId, null, `payment.event.${outcome}`, payment.id, {
      provider: event.provider,
      kind: event.kind,
    });
    return { status: outcome, paymentStatus: next };
  });
}

type PaymentRow = typeof payments.$inferSelect;

/** Extends the workspace subscription by the paid period (from its end if still running). */
async function activate(tx: Tx, payment: PaymentRow, paidAt: Date): Promise<void> {
  const [current] = await tx
    .select()
    .from(subscriptions)
    .where(eq(subscriptions.workspaceId, payment.workspaceId))
    .for('update');
  const running =
    current !== undefined &&
    current.planId === payment.planId &&
    current.status === 'active' &&
    current.currentPeriodEnd !== null &&
    current.currentPeriodEnd > paidAt;
  const start =
    running && current.currentPeriodStart !== null ? current.currentPeriodStart : paidAt;
  const from = running && current.currentPeriodEnd !== null ? current.currentPeriodEnd : paidAt;
  const end = new Date(from.getTime() + payment.periodDays * DAY_MS);
  const values = {
    planId: payment.planId,
    status: 'active' as const,
    provider: payment.provider,
    currentPeriodStart: start,
    currentPeriodEnd: end,
    cancelAtPeriodEnd: false,
  };
  if (current === undefined) {
    await tx.insert(subscriptions).values({ workspaceId: payment.workspaceId, ...values });
  } else {
    await tx.update(subscriptions).set(values).where(eq(subscriptions.id, current.id));
  }
}

/** A refund removes the paid period it bought; the workspace falls back to the free plan. */
async function revoke(tx: Tx, payment: PaymentRow, refundedAt: Date): Promise<void> {
  const [current] = await tx
    .select()
    .from(subscriptions)
    .where(eq(subscriptions.workspaceId, payment.workspaceId))
    .for('update');
  if (current === undefined || current.planId !== payment.planId) return;
  const [latest] = await tx
    .select({ id: payments.id })
    .from(payments)
    .where(and(eq(payments.planId, payment.planId), eq(payments.status, 'succeeded')))
    .orderBy(desc(payments.paidAt))
    .limit(1);
  if (latest !== undefined) {
    // Another paid period remains: shorten by the refunded one only.
    const end =
      current.currentPeriodEnd === null
        ? null
        : new Date(current.currentPeriodEnd.getTime() - payment.periodDays * DAY_MS);
    await tx
      .update(subscriptions)
      .set(
        end === null || end <= refundedAt
          ? { status: 'canceled', currentPeriodEnd: refundedAt }
          : { currentPeriodEnd: end },
      )
      .where(eq(subscriptions.id, current.id));
    return;
  }
  await tx
    .update(subscriptions)
    .set({ status: 'canceled', currentPeriodEnd: refundedAt })
    .where(eq(subscriptions.id, current.id));
}

async function audit(
  tx: Tx,
  workspaceId: string,
  actorUserId: string | null,
  action: string,
  paymentId: string,
  metadata: Record<string, string>,
): Promise<void> {
  await tx.insert(auditLog).values({
    workspaceId,
    actorUserId,
    action,
    entityType: 'payment',
    entityId: paymentId,
    metadata,
  });
}

/** The provider's view of one payment, as returned by its reporting API or export. */
export interface ProviderPaymentRecord {
  providerPaymentId: string;
  status: 'pending' | 'succeeded' | 'failed' | 'refunded';
  amountMinor: number;
  currency: string;
}

export interface LocalPaymentRecord extends ProviderPaymentRecord {
  id: string;
}

export interface ReconciliationReport {
  matched: number;
  missingLocally: string[];
  missingAtProvider: string[];
  amountMismatch: string[];
  statusMismatch: string[];
}

/**
 * Compares local payments with the provider's records (by provider payment id). Pure:
 * it reports differences and never changes anything — corrections are a human decision.
 */
export function reconcilePayments(
  local: LocalPaymentRecord[],
  provider: ProviderPaymentRecord[],
): ReconciliationReport {
  const report: ReconciliationReport = {
    matched: 0,
    missingLocally: [],
    missingAtProvider: [],
    amountMismatch: [],
    statusMismatch: [],
  };
  const remote = new Map(provider.map((record) => [record.providerPaymentId, record]));
  for (const record of local) {
    const other = remote.get(record.providerPaymentId);
    if (other === undefined) {
      if (record.status !== 'pending') report.missingAtProvider.push(record.providerPaymentId);
      continue;
    }
    remote.delete(record.providerPaymentId);
    if (other.amountMinor !== record.amountMinor || other.currency !== record.currency) {
      report.amountMismatch.push(record.providerPaymentId);
    } else if (other.status !== record.status) {
      report.statusMismatch.push(record.providerPaymentId);
    } else report.matched += 1;
  }
  report.missingLocally.push(...remote.keys());
  for (const list of [
    report.missingLocally,
    report.missingAtProvider,
    report.amountMismatch,
    report.statusMismatch,
  ]) {
    list.sort();
  }
  return report;
}

/** A workspace's payments that carry a provider id, for `reconcilePayments`. */
export async function listPaymentsForReconciliation(
  database: Database,
  workspaceId: string,
): Promise<LocalPaymentRecord[]> {
  if (!z.uuid().safeParse(workspaceId).success) throw new PaymentError('PAYMENT_INVALID_INPUT');
  const rows = await database.withWorkspace(workspaceId, (tx) =>
    tx
      .select({
        id: payments.id,
        providerPaymentId: payments.providerPaymentId,
        status: payments.status,
        amountMinor: payments.amountMinor,
        currency: payments.currency,
      })
      .from(payments)
      .where(sql`${payments.providerPaymentId} IS NOT NULL`),
  );
  return rows.flatMap((row) =>
    row.providerPaymentId === null ? [] : [{ ...row, providerPaymentId: row.providerPaymentId }],
  );
}
