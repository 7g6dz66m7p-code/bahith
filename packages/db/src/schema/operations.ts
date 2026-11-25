import {
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
  foreignKey,
} from 'drizzle-orm/pg-core';

import { createdAt, id, tenantExtras } from './_shared';
import { agentRunStatusEnum } from './enums';
import { userRef, workspaceIdColumn } from './identity';
import { projects } from './projects';

/**
 * One model/agent invocation: accounting and observability metadata only.
 * No prompt text, document text or model output is stored here.
 */
export const agentRuns = pgTable(
  'agent_runs',
  {
    id: id(),
    workspaceId: workspaceIdColumn(),
    projectId: uuid('project_id'),
    userId: userRef('user_id'),
    agent: text('agent').notNull(),
    promptVersion: text('prompt_version').notNull(),
    provider: text('provider').notNull(),
    model: text('model').notNull(),
    status: agentRunStatusEnum('status').notNull().default('queued'),
    inputTokens: integer('input_tokens'),
    outputTokens: integer('output_tokens'),
    firstTokenMs: integer('first_token_ms'),
    latencyMs: integer('latency_ms'),
    errorCode: text('error_code'),
    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    ...tenantExtras('agent_runs', t),
    index('agent_runs_workspace_id_created_at_idx').on(t.workspaceId, t.createdAt),
    foreignKey({
      name: 'agent_runs_project_fk',
      columns: [t.workspaceId, t.projectId],
      foreignColumns: [projects.workspaceId, projects.id],
    }).onDelete('cascade'),
  ],
);

/**
 * Append-only audit trail (the application role may only INSERT and SELECT).
 * `metadata` carries identifiers and enums only — never research content.
 */
export const auditLog = pgTable(
  'audit_log',
  {
    id: id(),
    workspaceId: workspaceIdColumn(),
    actorUserId: userRef('actor_user_id'),
    action: text('action').notNull(),
    entityType: text('entity_type'),
    entityId: uuid('entity_id'),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: createdAt(),
  },
  (t) => [
    ...tenantExtras('audit_log', t),
    index('audit_log_workspace_id_created_at_idx').on(t.workspaceId, t.createdAt),
  ],
);
