import { and, asc, eq } from 'drizzle-orm';
import { z } from 'zod';

import type { Database, Tx } from './client';
import {
  readLatestVersion,
  requireDocument,
  saveDocumentSchema,
  saveVersionInTx,
} from './documents';
import {
  commentAnchorSchema,
  locateQuote,
  replaceRange,
  replacementSchema,
  textAt,
} from './review-anchor';
import { notify } from './notifications';
import type { CommentAnchor, CommentSuggestion } from './schema/index';
import { auditLog, documentComments, documentVersions, memberships } from './schema/index';
import type { MembershipRole, SanadProjectContext } from './sanad/access';
import { withSanadProject } from './sanad/access';
import { SanadError } from './sanad/errors';

/**
 * Draft review: comments and suggested changes (tracked changes) on a draft.
 *
 * Roles: every member may read the review notes; owners, editors and supervisors may
 * comment and suggest; only owners and editors decide on a suggestion (accept / reject),
 * because accepting changes the content. A supervisor never writes content directly.
 *
 * A suggestion is applied only where its quoted text still is (see locateQuote); the new
 * content becomes a new version through the ordinary save path, so a concurrent save is
 * still refused with SANAD_VERSION_CONFLICT. Audit entries carry ids only, never text.
 */

/** The trusted request context plus the author's display name (from the server session). */
export interface ReviewContext extends SanadProjectContext {
  userName: string;
}

export const addCommentSchema = z.strictObject({
  anchor: commentAnchorSchema,
  body: z.string().trim().min(1).max(5000),
});

export const addSuggestionSchema = z
  .strictObject({
    anchor: commentAnchorSchema,
    replacement: replacementSchema,
    body: z.string().trim().max(5000).default(''),
  })
  .refine((input) => input.replacement !== input.anchor.quote);

export const acceptSuggestionSchema = z.strictObject({
  /** The version the accepting editor has; the suggestion is applied on top of it. */
  baseVersion: z.number().int().min(1),
});

export interface ReviewComment {
  id: string;
  documentId: string;
  kind: 'comment' | 'suggestion';
  status: 'open' | 'resolved' | 'accepted' | 'rejected';
  anchor: CommentAnchor;
  body: string;
  suggestion: CommentSuggestion | null;
  authorId: string | null;
  authorName: string;
  /** The author's current role in the workspace (null once they left it). */
  authorRole: MembershipRole | null;
  resolvedAt: string | null;
  appliedVersion: number | null;
  createdAt: string;
}

const uuid = z.uuid();

function requireIds(...ids: string[]) {
  for (const value of ids) {
    if (!uuid.safeParse(value).success) throw new SanadError('SANAD_INVALID_INPUT');
  }
}

const commentColumns = {
  id: documentComments.id,
  documentId: documentComments.documentId,
  kind: documentComments.kind,
  status: documentComments.status,
  anchor: documentComments.anchor,
  body: documentComments.body,
  suggestion: documentComments.suggestion,
  authorId: documentComments.authorId,
  authorName: documentComments.authorName,
  authorRole: memberships.role,
  resolvedAt: documentComments.resolvedAt,
  appliedVersion: documentComments.appliedVersion,
  createdAt: documentComments.createdAt,
};

async function selectComments(
  tx: Tx,
  context: SanadProjectContext,
  documentId: string,
  commentId?: string,
): Promise<ReviewComment[]> {
  const rows = await tx
    .select(commentColumns)
    .from(documentComments)
    .leftJoin(
      memberships,
      and(
        eq(memberships.workspaceId, documentComments.workspaceId),
        eq(memberships.userId, documentComments.authorId),
      ),
    )
    .where(
      and(
        eq(documentComments.workspaceId, context.workspaceId),
        eq(documentComments.documentId, documentId),
        ...(commentId === undefined ? [] : [eq(documentComments.id, commentId)]),
      ),
    )
    .orderBy(asc(documentComments.createdAt), asc(documentComments.id))
    .limit(2_000);
  return rows.map((row) => ({
    ...row,
    suggestion: row.suggestion ?? null,
    resolvedAt: row.resolvedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  }));
}

/** Checks that the anchor names a stored version and that its quote is exactly there. */
async function verifyAnchor(
  tx: Tx,
  context: SanadProjectContext,
  documentId: string,
  anchor: CommentAnchor,
): Promise<void> {
  const [row] = await tx
    .select({ content: documentVersions.content })
    .from(documentVersions)
    .where(
      and(
        eq(documentVersions.workspaceId, context.workspaceId),
        eq(documentVersions.documentId, documentId),
        eq(documentVersions.version, anchor.versionNumber),
      ),
    );
  if (row === undefined || textAt(row.content, anchor.from, anchor.to) !== anchor.quote) {
    throw new SanadError('REVIEW_ANCHOR_INVALID');
  }
}

async function insertNote(
  database: Database,
  context: ReviewContext,
  documentId: string,
  note: { anchor: CommentAnchor; body: string; suggestion: CommentSuggestion | null },
): Promise<ReviewComment> {
  const kind = note.suggestion === null ? 'comment' : 'suggestion';
  return withSanadProject(database, context, 'review', async (tx) => {
    await requireDocument(tx, context, documentId, false);
    await verifyAnchor(tx, context, documentId, note.anchor);
    const [row] = await tx
      .insert(documentComments)
      .values({
        workspaceId: context.workspaceId,
        documentId,
        kind,
        anchor: note.anchor,
        body: note.body,
        suggestion: note.suggestion,
        authorId: context.userId,
        authorName: context.userName.trim().slice(0, 200),
      })
      .returning({ id: documentComments.id });
    if (row === undefined) throw new SanadError('SANAD_INVALID_INPUT');
    await tx.insert(auditLog).values({
      workspaceId: context.workspaceId,
      actorUserId: context.userId,
      action: kind === 'comment' ? 'document.comment_added' : 'document.suggestion_added',
      entityType: 'document',
      entityId: documentId,
      metadata: { commentId: row.id },
    });
    // Owners and editors decide on review notes; tell them (not the author) one arrived.
    await notify(tx, {
      workspaceId: context.workspaceId,
      kind: 'review_comment',
      entityType: 'document',
      entityId: documentId,
      projectId: context.projectId,
      roles: ['owner', 'editor'],
      exceptUserId: context.userId,
    });
    const [created] = await selectComments(tx, context, documentId, row.id);
    if (created === undefined) throw new SanadError('REVIEW_NOT_FOUND');
    return created;
  });
}

export async function addComment(
  database: Database,
  context: ReviewContext,
  documentId: string,
  input: unknown,
): Promise<ReviewComment> {
  requireIds(documentId);
  const parsed = addCommentSchema.safeParse(input);
  if (!parsed.success) throw new SanadError('SANAD_INVALID_INPUT');
  return insertNote(database, context, documentId, { ...parsed.data, suggestion: null });
}

export async function addSuggestion(
  database: Database,
  context: ReviewContext,
  documentId: string,
  input: unknown,
): Promise<ReviewComment> {
  requireIds(documentId);
  const parsed = addSuggestionSchema.safeParse(input);
  if (!parsed.success) throw new SanadError('SANAD_INVALID_INPUT');
  const { anchor, body, replacement } = parsed.data;
  return insertNote(database, context, documentId, {
    anchor,
    body,
    suggestion: { replacement },
  });
}

/** Every review note of a draft, oldest first. Any member of the workspace may read them. */
export async function listComments(
  database: Database,
  context: SanadProjectContext,
  documentId: string,
): Promise<ReviewComment[]> {
  requireIds(documentId);
  return withSanadProject(database, context, 'read', async (tx) => {
    await requireDocument(tx, context, documentId, false);
    return selectComments(tx, context, documentId);
  });
}

/** Locks an open note of the draft; refuses notes of another kind or already closed. */
async function lockOpenNote(
  tx: Tx,
  context: SanadProjectContext,
  documentId: string,
  commentId: string,
  kind: 'comment' | 'suggestion',
) {
  const [row] = await tx
    .select({
      id: documentComments.id,
      kind: documentComments.kind,
      status: documentComments.status,
      anchor: documentComments.anchor,
      suggestion: documentComments.suggestion,
    })
    .from(documentComments)
    .where(
      and(
        eq(documentComments.workspaceId, context.workspaceId),
        eq(documentComments.documentId, documentId),
        eq(documentComments.id, commentId),
      ),
    )
    .for('update');
  if (row === undefined) throw new SanadError('REVIEW_NOT_FOUND');
  if (row.status !== 'open' || row.kind !== kind) throw new SanadError('REVIEW_INVALID_STATE');
  return row;
}

async function closeNote(
  tx: Tx,
  context: SanadProjectContext,
  documentId: string,
  commentId: string,
  status: 'resolved' | 'accepted' | 'rejected',
  appliedVersion: number | null,
): Promise<ReviewComment> {
  await tx
    .update(documentComments)
    .set({ status, resolvedBy: context.userId, resolvedAt: new Date(), appliedVersion })
    .where(
      and(
        eq(documentComments.workspaceId, context.workspaceId),
        eq(documentComments.id, commentId),
      ),
    );
  const action =
    status === 'resolved'
      ? 'document.comment_resolved'
      : status === 'accepted'
        ? 'document.suggestion_accepted'
        : 'document.suggestion_rejected';
  await tx.insert(auditLog).values({
    workspaceId: context.workspaceId,
    actorUserId: context.userId,
    action,
    entityType: 'document',
    entityId: documentId,
    metadata: appliedVersion === null ? { commentId } : { commentId, version: appliedVersion },
  });
  const [updated] = await selectComments(tx, context, documentId, commentId);
  if (updated === undefined) throw new SanadError('REVIEW_NOT_FOUND');
  if (status !== 'resolved') {
    // The suggestion's author learns it was accepted or declined.
    await notify(tx, {
      workspaceId: context.workspaceId,
      kind: 'suggestion_decided',
      entityType: 'document',
      entityId: documentId,
      projectId: context.projectId,
      userIds: [updated.authorId],
      exceptUserId: context.userId,
    });
  }
  return updated;
}

/** Marks a comment as resolved. Owners, editors and supervisors may resolve comments. */
export async function resolveComment(
  database: Database,
  context: SanadProjectContext,
  documentId: string,
  commentId: string,
): Promise<ReviewComment> {
  requireIds(documentId, commentId);
  return withSanadProject(database, context, 'review', async (tx) => {
    await requireDocument(tx, context, documentId, false);
    await lockOpenNote(tx, context, documentId, commentId, 'comment');
    return closeNote(tx, context, documentId, commentId, 'resolved', null);
  });
}

/** Declines a suggestion; the content is not changed. Owners and editors only. */
export async function rejectSuggestion(
  database: Database,
  context: SanadProjectContext,
  documentId: string,
  commentId: string,
): Promise<ReviewComment> {
  requireIds(documentId, commentId);
  return withSanadProject(database, context, 'write', async (tx) => {
    await requireDocument(tx, context, documentId, false);
    await lockOpenNote(tx, context, documentId, commentId, 'suggestion');
    return closeNote(tx, context, documentId, commentId, 'rejected', null);
  });
}

export interface AcceptedSuggestion {
  comment: ReviewComment;
  /** The new version, which contains the replacement. */
  version: number;
  content: Record<string, unknown>;
}

/**
 * Applies a suggestion to the latest version and saves the result as a new version.
 * Owners and editors only. Refused with SANAD_VERSION_CONFLICT when `baseVersion` is not
 * the latest version, and with REVIEW_ANCHOR_STALE when the quoted text is no longer
 * found exactly (and unambiguously) at or near its anchor.
 */
export async function acceptSuggestion(
  database: Database,
  context: SanadProjectContext,
  documentId: string,
  commentId: string,
  input: unknown,
): Promise<AcceptedSuggestion> {
  requireIds(documentId, commentId);
  const parsed = acceptSuggestionSchema.safeParse(input);
  if (!parsed.success) throw new SanadError('SANAD_INVALID_INPUT');
  return withSanadProject(database, context, 'write', async (tx) => {
    // Lock order as in saveDocument: the document first, then the note.
    await requireDocument(tx, context, documentId, true);
    const note = await lockOpenNote(tx, context, documentId, commentId, 'suggestion');
    if (note.suggestion === null) throw new SanadError('REVIEW_INVALID_STATE');
    const latest = await readLatestVersion(tx, context, documentId);
    if (latest === undefined || latest.version !== parsed.data.baseVersion) {
      throw new SanadError('SANAD_VERSION_CONFLICT');
    }
    const range = locateQuote(
      latest.content,
      note.anchor,
      latest.version === note.anchor.versionNumber,
    );
    if (range === null) throw new SanadError('REVIEW_ANCHOR_STALE');
    const content = replaceRange(latest.content, range.from, range.to, note.suggestion.replacement);
    const save = saveDocumentSchema.safeParse({
      content,
      baseVersion: latest.version,
      kind: 'manual',
    });
    if (!save.success) throw new SanadError('SANAD_INVALID_INPUT');
    const saved = await saveVersionInTx(tx, context, documentId, save.data);
    const comment = await closeNote(tx, context, documentId, commentId, 'accepted', saved.version);
    return { comment, version: saved.version, content: save.data.content };
  });
}
