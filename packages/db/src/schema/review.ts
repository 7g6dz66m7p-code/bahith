import { sql } from 'drizzle-orm';
import {
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';

import { createdAt, id, tenantExtras, updatedAt } from './_shared';
import { documents } from './documents';
import { documentCommentKindEnum, documentCommentStatusEnum } from './enums';
import { userRef, workspaceIdColumn } from './identity';

/**
 * Where a review note points: ProseMirror positions in the draft at `versionNumber`, and
 * the exact text that was selected there. The quote is what a suggestion replaces; it is
 * checked against the stored version on creation and against the latest one on accept.
 */
export interface CommentAnchor {
  versionNumber: number;
  from: number;
  to: number;
  quote: string;
}

export interface CommentSuggestion {
  replacement: string;
}

/** Supervisor comments and suggested changes on a draft (the review trail). */
export const documentComments = pgTable(
  'document_comments',
  {
    id: id(),
    workspaceId: workspaceIdColumn(),
    documentId: uuid('document_id').notNull(),
    kind: documentCommentKindEnum('kind').notNull(),
    status: documentCommentStatusEnum('status').notNull().default('open'),
    anchor: jsonb('anchor').$type<CommentAnchor>().notNull(),
    body: text('body').notNull().default(''),
    suggestion: jsonb('suggestion').$type<CommentSuggestion>(),
    authorId: userRef('author_id'),
    /** Display name when written: members cannot read each other's user rows. */
    authorName: text('author_name').notNull().default(''),
    resolvedBy: userRef('resolved_by'),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    /** The document version an accepted suggestion created. */
    appliedVersion: integer('applied_version'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    ...tenantExtras('document_comments', t),
    index('document_comments_document_id_idx').on(t.workspaceId, t.documentId, t.createdAt),
    foreignKey({
      name: 'document_comments_document_fk',
      columns: [t.workspaceId, t.documentId],
      foreignColumns: [documents.workspaceId, documents.id],
    }).onDelete('cascade'),
    check('document_comments_body_length', sql`char_length(${t.body}) <= 5000`),
    check('document_comments_author_name_length', sql`char_length(${t.authorName}) <= 200`),
    check(
      'document_comments_suggestion_kind',
      sql`(${t.kind} = 'suggestion') = (${t.suggestion} is not null)`,
    ),
    check(
      'document_comments_status_kind',
      sql`${t.status} in ('open', 'resolved') or ${t.kind} = 'suggestion'`,
    ),
    check('document_comments_closed_at', sql`(${t.status} = 'open') = (${t.resolvedAt} is null)`),
    check(
      'document_comments_applied_version',
      sql`(${t.status} = 'accepted') = (${t.appliedVersion} is not null)`,
    ),
  ],
);
