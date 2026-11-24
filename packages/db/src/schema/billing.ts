import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  date,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';

import { createdAt, id, tenantExtras, updatedAt } from './_shared';
import { paymentStatusEnum, subscriptionStatusEnum } from './enums';
import { users, workspaceIdColumn } from './identity';

/** Quota per metric for one billing period; a missing key means "not allowed". */
export type PlanLimits = Record<string, number>;

/** Global plan catalogue (free + one paid plan). Read-only for the application role. */
export const plans = pgTable(
  'plans',
  {
    id: id(),
    code: text('code').notNull(),
    name: text('name').notNull(),
    limits: jsonb('limits').$type<PlanLimits>().notNull(),
    isActive: boolean('is_active').notNull().default(true),
    /**
     * Price per period in the currency's minor unit. NULL = not purchasable: prices are
     * set by the owner, never invented by the code or seeded.
     */
    priceMinor: bigint('price_minor', { mode: 'number' }),
    currency: text('currency'),
    periodDays: integer('period_days'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique('plans_code_key').on(t.code),
    check(
      'plans_price_complete',
      sql`(${t.priceMinor} IS NULL AND ${t.currency} IS NULL AND ${t.periodDays} IS NULL) OR (${t.priceMinor} > 0 AND ${t.currency} ~ '^[A-Z]{3}$' AND ${t.periodDays} BETWEEN 1 AND 366)`,
    ),
  ],
);

export const subscriptions = pgTable(
  'subscriptions',
  {
    id: id(),
    workspaceId: workspaceIdColumn(),
    planId: uuid('plan_id')
      .notNull()
      .references(() => plans.id),
    status: subscriptionStatusEnum('status').notNull().default('active'),
    provider: text('provider'),
    providerCustomerId: text('provider_customer_id'),
    providerSubscriptionId: text('provider_subscription_id'),
    currentPeriodStart: timestamp('current_period_start', { withTimezone: true }),
    currentPeriodEnd: timestamp('current_period_end', { withTimezone: true }),
    cancelAtPeriodEnd: boolean('cancel_at_period_end').notNull().default(false),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    ...tenantExtras('subscriptions', t),
    // One subscription per workspace.
    unique('subscriptions_workspace_id_key').on(t.workspaceId),
  ],
);

/** Usage of one metric in one period; checked against the plan before each model call. */
export const usageCounters = pgTable(
  'usage_counters',
  {
    id: id(),
    workspaceId: workspaceIdColumn(),
    metric: text('metric').notNull(),
    periodStart: date('period_start').notNull(),
    periodEnd: date('period_end').notNull(),
    used: bigint('used', { mode: 'number' }).notNull().default(0),
    updatedAt: updatedAt(),
  },
  (t) => [
    ...tenantExtras('usage_counters', t),
    unique('usage_counters_workspace_metric_period_key').on(t.workspaceId, t.metric, t.periodStart),
    index('usage_counters_workspace_id_idx').on(t.workspaceId),
    check('usage_counters_used_non_negative', sql`${t.used} >= 0`),
    check('usage_counters_period_valid', sql`${t.periodEnd} > ${t.periodStart}`),
  ],
);

/**
 * One payment attempt for a plan period. Created by the workspace owner before the
 * provider checkout; only a verified provider event (never the browser) moves it out of
 * `pending`. Amount and currency are copied from the plan at creation and compared with
 * what the provider reports before anything is activated.
 */
export const payments = pgTable(
  'payments',
  {
    id: id(),
    workspaceId: workspaceIdColumn(),
    planId: uuid('plan_id')
      .notNull()
      .references(() => plans.id),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    provider: text('provider').notNull(),
    providerPaymentId: text('provider_payment_id'),
    amountMinor: bigint('amount_minor', { mode: 'number' }).notNull(),
    currency: text('currency').notNull(),
    periodDays: integer('period_days').notNull(),
    status: paymentStatusEnum('status').notNull().default('pending'),
    paidAt: timestamp('paid_at', { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    ...tenantExtras('payments', t),
    unique('payments_provider_payment_id_key').on(t.provider, t.providerPaymentId),
    index('payments_workspace_id_idx').on(t.workspaceId, t.createdAt),
    check('payments_amount_positive', sql`${t.amountMinor} > 0`),
    check('payments_currency_iso', sql`${t.currency} ~ '^[A-Z]{3}$'`),
    check('payments_period_valid', sql`${t.periodDays} BETWEEN 1 AND 366`),
  ],
);

/**
 * Verified provider events, stored once per (provider, event id): replays and duplicate
 * webhook deliveries are recognised and never applied twice. Holds ids, codes and
 * amounts only — no card data and no raw payload.
 */
export const paymentEvents = pgTable(
  'payment_events',
  {
    id: id(),
    workspaceId: workspaceIdColumn(),
    paymentId: uuid('payment_id').notNull(),
    provider: text('provider').notNull(),
    eventId: text('event_id').notNull(),
    kind: text('kind').notNull(),
    amountMinor: bigint('amount_minor', { mode: 'number' }),
    currency: text('currency'),
    /** applied | ignored | mismatch: what processing did with the event. */
    outcome: text('outcome').notNull(),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
    receivedAt: createdAt(),
  },
  (t) => [
    ...tenantExtras('payment_events', t),
    unique('payment_events_provider_event_id_key').on(t.provider, t.eventId),
    foreignKey({
      name: 'payment_events_payment_fk',
      columns: [t.workspaceId, t.paymentId],
      foreignColumns: [payments.workspaceId, payments.id],
    }).onDelete('cascade'),
    index('payment_events_payment_id_idx').on(t.workspaceId, t.paymentId),
    check('payment_events_kind_valid', sql`${t.kind} IN ('succeeded', 'failed', 'refunded')`),
    check('payment_events_outcome_valid', sql`${t.outcome} IN ('applied', 'ignored', 'mismatch')`),
  ],
);
