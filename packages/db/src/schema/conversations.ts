import {
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  real,
  text,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';

import { createdAt, id, tenantExtras, updatedAt } from './_shared';
import { claimSupportStatusEnum, messageRoleEnum } from './enums';
import { userRef, workspaceIdColumn } from './identity';
import { agentRuns } from './operations';
import { documents } from './documents';
import { projects } from './projects';
import { chunks } from './sources';

export const conversations = pgTable(
  'conversations',
  {
    id: id(),
    workspaceId: workspaceIdColumn(),
    projectId: uuid('project_id').notNull(),
    title: text('title'),
    createdBy: userRef('created_by'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    ...tenantExtras('conversations', t),
    index('conversations_project_id_idx').on(t.workspaceId, t.projectId),
    foreignKey({
      name: 'conversations_project_fk',
      columns: [t.workspaceId, t.projectId],
      foreignColumns: [projects.workspaceId, projects.id],
    }).onDelete('cascade'),
  ],
);

export const messages = pgTable(
  'messages',
  {
    id: id(),
    workspaceId: workspaceIdColumn(),
    conversationId: uuid('conversation_id').notNull(),
    role: messageRoleEnum('role').notNull(),
    /** Structured, schema-validated message body (see @bahith/ai). */
    content: jsonb('content').$type<Record<string, unknown>>().notNull(),
    agentRunId: uuid('agent_run_id'),
    createdAt: createdAt(),
  },
  (t) => [
    ...tenantExtras('messages', t),
    index('messages_conversation_id_idx').on(t.workspaceId, t.conversationId, t.createdAt),
    foreignKey({
      name: 'messages_conversation_fk',
      columns: [t.workspaceId, t.conversationId],
      foreignColumns: [conversations.workspaceId, conversations.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'messages_agent_run_fk',
      columns: [t.workspaceId, t.agentRunId],
      foreignColumns: [agentRuns.workspaceId, agentRuns.id],
    }),
  ],
);

/**
 * One generated statement. `support_status` is mandatory: a claim is either backed by
 * rows in `claim_evidence` or explicitly labelled inference / hypothesis / unsupported.
 * A claim originates from an assistant message or from a document (or neither, while drafting).
 */
export const claims = pgTable(
  'claims',
  {
    id: id(),
    workspaceId: workspaceIdColumn(),
    projectId: uuid('project_id').notNull(),
    messageId: uuid('message_id'),
    documentId: uuid('document_id'),
    position: integer('position').notNull().default(0),
    text: text('text').notNull(),
    supportStatus: claimSupportStatusEnum('support_status').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    ...tenantExtras('claims', t),
    index('claims_project_id_idx').on(t.workspaceId, t.projectId),
    index('claims_message_id_idx').on(t.workspaceId, t.messageId),
    index('claims_document_id_idx').on(t.workspaceId, t.documentId),
    foreignKey({
      name: 'claims_project_fk',
      columns: [t.workspaceId, t.projectId],
      foreignColumns: [projects.workspaceId, projects.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'claims_message_fk',
      columns: [t.workspaceId, t.messageId],
      foreignColumns: [messages.workspaceId, messages.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'claims_document_fk',
      columns: [t.workspaceId, t.documentId],
      foreignColumns: [documents.workspaceId, documents.id],
    }).onDelete('cascade'),
  ],
);

/**
 * Links a claim to the passage that supports it. Source and page are read from the
 * chunk row, so they cannot drift from what was actually retrieved.
 */
export const claimEvidence = pgTable(
  'claim_evidence',
  {
    id: id(),
    workspaceId: workspaceIdColumn(),
    claimId: uuid('claim_id').notNull(),
    chunkId: uuid('chunk_id').notNull(),
    /** Verbatim span of the chunk that supports the claim. */
    quote: text('quote'),
    relevance: real('relevance'),
    createdAt: createdAt(),
  },
  (t) => [
    ...tenantExtras('claim_evidence', t),
    unique('claim_evidence_claim_id_chunk_id_key').on(t.claimId, t.chunkId),
    index('claim_evidence_chunk_id_idx').on(t.workspaceId, t.chunkId),
    foreignKey({
      name: 'claim_evidence_claim_fk',
      columns: [t.workspaceId, t.claimId],
      foreignColumns: [claims.workspaceId, claims.id],
    }).onDelete('cascade'),
    // No cascade: evidence must not vanish silently when a file is re-processed.
    foreignKey({
      name: 'claim_evidence_chunk_fk',
      columns: [t.workspaceId, t.chunkId],
      foreignColumns: [chunks.workspaceId, chunks.id],
    }),
  ],
);
