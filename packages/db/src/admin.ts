import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';

import { AI_REQUESTS_METRIC } from './assistant';
import type { Database } from './client';
import { MemberError } from './members';
import type { WorkspaceActor } from './members';
import { memberships, plans, subscriptions, usageCounters } from './schema/index';

export const platformStatsSchema = z.object({
  users: z.number(),
  verifiedUsers: z.number(),
  workspaces: z.number(),
  projects: z.number(),
  sources: z.number(),
  files: z.record(z.string(), z.number()),
  chunks: z.number(),
  embeddedChunks: z.number(),
  documents: z.number(),
  agentRunsThisMonth: z.record(z.string(), z.number()),
  aiRequestsThisMonth: z.number(),
});

export type PlatformStats = z.infer<typeof platformStatsSchema>;

/**
 * Aggregate counts across the platform (numbers only). The caller must already have
 * established that the user is a platform administrator.
 */
export async function getPlatformStats(database: Database): Promise<PlatformStats> {
  const result = await database.pool.query<{ stats: unknown }>(
    'SELECT app.platform_stats() AS stats',
  );
  return platformStatsSchema.parse(result.rows[0]?.stats);
}

export async function listPlans(database: Database) {
  return database.db
    .select({ code: plans.code, name: plans.name, limits: plans.limits, isActive: plans.isActive })
    .from(plans)
    .orderBy(asc(plans.code));
}

export class PlanError extends Error {
  constructor(readonly code: 'PLAN_INVALID' | 'PLAN_NOT_FOUND') {
    super(code);
    this.name = 'PlanError';
  }
}

/** Sets a plan's monthly AI request limit (platform administrators only, checked by the caller). */
export async function setPlanAiRequestLimit(
  database: Database,
  planCode: string,
  value: number,
): Promise<Record<string, number>> {
  const code = z
    .string()
    .regex(/^[a-z][a-z0-9-]{0,39}$/u)
    .safeParse(planCode);
  const limit = z.number().int().min(0).max(1_000_000).safeParse(value);
  if (!code.success || !limit.success) throw new PlanError('PLAN_INVALID');
  try {
    const result = await database.pool.query<{ limits: Record<string, number> }>(
      'SELECT app.set_plan_limit($1, $2, $3) AS limits',
      [code.data, AI_REQUESTS_METRIC, limit.data],
    );
    return result.rows[0]?.limits ?? {};
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'P0002') {
      throw new PlanError('PLAN_NOT_FOUND');
    }
    throw error;
  }
}

export interface WorkspaceUsage {
  plan: { code: string; name: string } | null;
  /** Requests this calendar month (UTC) and the plan's limit (null = not set: no AI). */
  aiRequests: { used: number; limit: number | null; periodStart: string };
}

/** The workspace's plan and this month's AI usage (any member may see it). */
export async function getWorkspaceUsage(
  database: Database,
  actor: WorkspaceActor,
  now: Date = new Date(),
): Promise<WorkspaceUsage> {
  const periodStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
    .toISOString()
    .slice(0, 10);
  return database.withWorkspace(
    actor.workspaceId,
    async (tx) => {
      const [member] = await tx
        .select({ role: memberships.role })
        .from(memberships)
        .where(
          and(eq(memberships.workspaceId, actor.workspaceId), eq(memberships.userId, actor.userId)),
        );
      if (member === undefined) throw new MemberError('MEMBER_FORBIDDEN');
      const [subscribed] = await tx
        .select({ code: plans.code, name: plans.name, limits: plans.limits })
        .from(subscriptions)
        .innerJoin(plans, eq(plans.id, subscriptions.planId))
        .where(
          and(
            eq(subscriptions.workspaceId, actor.workspaceId),
            inArray(subscriptions.status, ['active', 'trialing']),
            // A paid period that has ended no longer counts (the free plan applies).
            sql`(${subscriptions.currentPeriodEnd} IS NULL OR ${subscriptions.currentPeriodEnd} > now())`,
          ),
        )
        .orderBy(desc(subscriptions.createdAt))
        .limit(1);
      const plan =
        subscribed ??
        (
          await tx
            .select({ code: plans.code, name: plans.name, limits: plans.limits })
            .from(plans)
            .where(eq(plans.code, 'free'))
        )[0];
      const [counter] = await tx
        .select({ used: usageCounters.used })
        .from(usageCounters)
        .where(
          and(
            eq(usageCounters.workspaceId, actor.workspaceId),
            eq(usageCounters.metric, AI_REQUESTS_METRIC),
            eq(usageCounters.periodStart, periodStart),
          ),
        );
      const limit = plan?.limits[AI_REQUESTS_METRIC];
      return {
        plan: plan === undefined ? null : { code: plan.code, name: plan.name },
        aiRequests: {
          used: counter?.used ?? 0,
          limit: typeof limit === 'number' && Number.isInteger(limit) ? limit : null,
          periodStart,
        },
      };
    },
    { userId: actor.userId },
  );
}
