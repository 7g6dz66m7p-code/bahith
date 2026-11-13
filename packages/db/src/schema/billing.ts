import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  date,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';

import { createdAt, id, tenantExtras, updatedAt } from './_shared';
import { subscriptionStatusEnum } from './enums';
import { workspaceIdColumn } from './identity';

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
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [unique('plans_code_key').on(t.code)],
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
