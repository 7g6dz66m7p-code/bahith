import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';

import type { Database } from './client';
import {
  agentRuns,
  auditLog,
  claimEvidence,
  claims,
  conversations,
  messages,
  plans,
  projects,
  subscriptions,
  usageCounters,
} from './schema/index';
import type { SanadProjectContext } from './sanad/access';
import { withSanadProject } from './sanad/access';

/** Plan limit key: model requests per workspace and calendar month (UTC). */
export const AI_REQUESTS_METRIC = 'ai_requests_per_month';

export type AssistantErrorCode =
  | 'AI_CONSENT_REQUIRED'
  | 'AI_QUOTA_NOT_CONFIGURED'
  | 'AI_QUOTA_EXCEEDED'
  | 'AI_RUN_NOT_FOUND'
  | 'AI_INVALID_INPUT';

/** Codes only: no question, passage or answer text. */
export class AssistantError extends Error {
  constructor(readonly code: AssistantErrorCode) {
    super(code);
    this.name = 'AssistantError';
  }
}

export interface ProjectAiConsent {
  enabled: boolean;
  at: Date | null;
}

/** Owner/editor records (or withdraws) consent to send this project's passages to the provider. */
export async function setProjectAiConsent(
  database: Database,
  context: SanadProjectContext,
  enabled: boolean,
): Promise<ProjectAiConsent> {
  return withSanadProject(database, context, true, async (tx) => {
    const at = enabled ? new Date() : null;
    await tx
      .update(projects)
      .set({ aiConsentAt: at, aiConsentBy: enabled ? context.userId : null })
      .where(
        and(eq(projects.workspaceId, context.workspaceId), eq(projects.id, context.projectId)),
      );
    await tx.insert(auditLog).values({
      workspaceId: context.workspaceId,
      actorUserId: context.userId,
      action: enabled ? 'project.ai_consent_granted' : 'project.ai_consent_withdrawn',
      entityType: 'project',
      entityId: context.projectId,
      metadata: {},
    });
    return { enabled, at };
  });
}

export async function getProjectAiConsent(
  database: Database,
  context: SanadProjectContext,
): Promise<ProjectAiConsent> {
  return withSanadProject(database, context, false, async (tx) => {
    const [row] = await tx
      .select({ at: projects.aiConsentAt })
      .from(projects)
      .where(
        and(eq(projects.workspaceId, context.workspaceId), eq(projects.id, context.projectId)),
      );
    return { enabled: row?.at != null, at: row?.at ?? null };
  });
}

function monthPeriod(now: Date): { start: string; end: string } {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  return { start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10) };
}

const runSchema = z.strictObject({
  agent: z.string().regex(/^[a-z][a-z0-9_.-]{1,63}$/),
  promptVersion: z.string().min(1).max(100),
  provider: z.string().min(1).max(64),
  model: z.string().min(1).max(200),
});

/**
 * Checks consent and the plan quota, reserves one request, and opens an agent run —
 * all before any provider is called. Fails closed: no consent, no plan, or no limit
 * for the metric means no call. A reserved request counts even if the call then fails.
 */
export async function startAssistantRun(
  database: Database,
  context: SanadProjectContext,
  input: z.input<typeof runSchema>,
  now: Date = new Date(),
): Promise<{ runId: string; used: number; limit: number }> {
  const run = runSchema.safeParse(input);
  if (!run.success) throw new AssistantError('AI_INVALID_INPUT');
  return withSanadProject(database, context, true, async (tx) => {
    const [project] = await tx
      .select({ consent: projects.aiConsentAt })
      .from(projects)
      .where(
        and(eq(projects.workspaceId, context.workspaceId), eq(projects.id, context.projectId)),
      );
    if (project?.consent == null) throw new AssistantError('AI_CONSENT_REQUIRED');

    const [plan] = await tx
      .select({ limits: plans.limits })
      .from(subscriptions)
      .innerJoin(plans, eq(plans.id, subscriptions.planId))
      .where(
        and(
          eq(subscriptions.workspaceId, context.workspaceId),
          inArray(subscriptions.status, ['active', 'trialing']),
          // A paid period that has ended no longer counts (the free plan applies).
          sql`(${subscriptions.currentPeriodEnd} IS NULL OR ${subscriptions.currentPeriodEnd} > now())`,
        ),
      )
      .orderBy(desc(subscriptions.createdAt))
      .limit(1);
    // A workspace without a subscription is on the free plan (the catalogue's 'free' row).
    const limits =
      plan?.limits ??
      (await tx.select({ limits: plans.limits }).from(plans).where(eq(plans.code, 'free')))[0]
        ?.limits;
    const limit = limits?.[AI_REQUESTS_METRIC];
    if (limit === undefined || !Number.isInteger(limit) || limit < 0) {
      throw new AssistantError('AI_QUOTA_NOT_CONFIGURED');
    }
    if (limit === 0) throw new AssistantError('AI_QUOTA_EXCEEDED');
    const period = monthPeriod(now);
    const [counter] = await tx
      .insert(usageCounters)
      .values({
        workspaceId: context.workspaceId,
        metric: AI_REQUESTS_METRIC,
        periodStart: period.start,
        periodEnd: period.end,
        used: 1,
      })
      .onConflictDoUpdate({
        target: [usageCounters.workspaceId, usageCounters.metric, usageCounters.periodStart],
        set: { used: sql`${usageCounters.used} + 1`, updatedAt: now },
        setWhere: sql`${usageCounters.used} < ${limit}`,
      })
      .returning({ used: usageCounters.used });
    if (counter === undefined) throw new AssistantError('AI_QUOTA_EXCEEDED');

    const [row] = await tx
      .insert(agentRuns)
      .values({
        workspaceId: context.workspaceId,
        projectId: context.projectId,
        userId: context.userId,
        ...run.data,
        status: 'running',
        startedAt: now,
      })
      .returning({ id: agentRuns.id });
    if (row === undefined) throw new AssistantError('AI_INVALID_INPUT');
    return { runId: row.id, used: counter.used, limit };
  });
}

const finishSchema = z.strictObject({
  status: z.enum(['succeeded', 'failed']),
  inputTokens: z.number().int().min(0).nullable(),
  outputTokens: z.number().int().min(0).nullable(),
  latencyMs: z.number().int().min(0).nullable(),
  errorCode: z
    .string()
    .regex(/^[A-Z][A-Z0-9_]{1,63}$/)
    .nullable(),
});

/** Records the outcome: metadata only (tokens, latency, error code), never text. */
export async function finishAssistantRun(
  database: Database,
  context: SanadProjectContext,
  runId: string,
  input: z.input<typeof finishSchema>,
): Promise<void> {
  const outcome = finishSchema.safeParse(input);
  if (!outcome.success || !z.uuid().safeParse(runId).success) {
    throw new AssistantError('AI_INVALID_INPUT');
  }
  await withSanadProject(database, context, true, async (tx) => {
    const updated = await tx
      .update(agentRuns)
      .set({ ...outcome.data, finishedAt: new Date() })
      .where(
        and(
          eq(agentRuns.workspaceId, context.workspaceId),
          eq(agentRuns.projectId, context.projectId),
          eq(agentRuns.id, runId),
          eq(agentRuns.status, 'running'),
        ),
      )
      .returning({ id: agentRuns.id });
    if (updated.length === 0) throw new AssistantError('AI_RUN_NOT_FOUND');
  });
}

const evidenceSchema = z.strictObject({
  chunkId: z.uuid(),
  quote: z.string().min(1).max(5000),
});

const exchangeSchema = z.strictObject({
  conversationId: z.uuid().nullable(),
  runId: z.uuid(),
  question: z.string().trim().min(1).max(2000),
  answer: z.strictObject({
    status: z.enum(['answered', 'abstained']),
    sentences: z
      .array(
        z.strictObject({
          text: z.string().min(1).max(2000),
          support: z.enum(['supported', 'inference', 'unsupported']),
          evidence: z.array(evidenceSchema).max(8),
        }),
      )
      .max(16),
  }),
});

/**
 * Stores the question, the grounded answer and one claim per sentence, linked to the
 * verified passages. The composite foreign keys reject a passage of another workspace.
 */
export async function saveAssistantExchange(
  database: Database,
  context: SanadProjectContext,
  input: z.input<typeof exchangeSchema>,
): Promise<{ conversationId: string; messageId: string; claimIds: string[] }> {
  const parsed = exchangeSchema.safeParse(input);
  if (!parsed.success) throw new AssistantError('AI_INVALID_INPUT');
  const { conversationId, runId, question, answer } = parsed.data;
  return withSanadProject(database, context, true, async (tx) => {
    const ws = context.workspaceId;
    let conversation = conversationId;
    if (conversation !== null) {
      const [existing] = await tx
        .select({ id: conversations.id })
        .from(conversations)
        .where(
          and(
            eq(conversations.workspaceId, ws),
            eq(conversations.projectId, context.projectId),
            eq(conversations.id, conversation),
          ),
        );
      if (existing === undefined) throw new AssistantError('AI_INVALID_INPUT');
    } else {
      const [created] = await tx
        .insert(conversations)
        .values({
          workspaceId: ws,
          projectId: context.projectId,
          title: question.slice(0, 120),
          createdBy: context.userId,
        })
        .returning({ id: conversations.id });
      if (created === undefined) throw new AssistantError('AI_INVALID_INPUT');
      conversation = created.id;
    }
    await tx.insert(messages).values({
      workspaceId: ws,
      conversationId: conversation,
      role: 'user',
      content: { text: question },
    });
    const [assistant] = await tx
      .insert(messages)
      .values({
        workspaceId: ws,
        conversationId: conversation,
        role: 'assistant',
        content: answer,
        agentRunId: runId,
      })
      .returning({ id: messages.id });
    if (assistant === undefined) throw new AssistantError('AI_INVALID_INPUT');
    const claimIds: string[] = [];
    for (const [position, sentence] of answer.sentences.entries()) {
      const [claim] = await tx
        .insert(claims)
        .values({
          workspaceId: ws,
          projectId: context.projectId,
          messageId: assistant.id,
          position,
          text: sentence.text,
          supportStatus: sentence.support,
        })
        .returning({ id: claims.id });
      if (claim === undefined) throw new AssistantError('AI_INVALID_INPUT');
      claimIds.push(claim.id);
      if (sentence.evidence.length > 0) {
        await tx.insert(claimEvidence).values(
          sentence.evidence.map((item) => ({
            workspaceId: ws,
            claimId: claim.id,
            chunkId: item.chunkId,
            quote: item.quote,
          })),
        );
      }
    }
    return { conversationId: conversation, messageId: assistant.id, claimIds };
  });
}
