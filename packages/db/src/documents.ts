import { and, desc, eq, max } from 'drizzle-orm';
import { z } from 'zod';

import type { Database } from './client';
import { auditLog, documents, documentVersions } from './schema/index';
import type { SanadProjectContext } from './sanad/access';
import { withSanadProject } from './sanad/access';
import { SanadError } from './sanad/errors';

/**
 * Research drafts. Every save is a new immutable version (the application role cannot
 * UPDATE document_versions), so the history is the document. Saves carry the version
 * they were based on: a save based on an older version than the latest is refused
 * (SANAD_VERSION_CONFLICT) instead of silently overwriting someone else's work.
 */

/** ProseMirror / Tiptap JSON. Only the shape is checked here; size is bounded. */
const proseMirrorNode: z.ZodType<Record<string, unknown>> = z.lazy(() =>
  z
    .object({
      type: z.string().min(1).max(64),
      attrs: z.record(z.string(), z.unknown()).optional(),
      content: z.array(proseMirrorNode).max(20_000).optional(),
      marks: z
        .array(z.object({ type: z.string().max(64) }).loose())
        .max(20)
        .optional(),
      text: z.string().max(200_000).optional(),
    })
    .loose(),
);

export const MAX_DOCUMENT_JSON_BYTES = 5 * 1024 * 1024;

const contentSchema = proseMirrorNode.refine(
  (value) => value.type === 'doc' && JSON.stringify(value).length <= MAX_DOCUMENT_JSON_BYTES,
);

export const createDocumentSchema = z.strictObject({
  title: z.string().trim().min(1).max(300),
});

export const saveDocumentSchema = z.strictObject({
  content: contentSchema,
  /** The version the editor started from; 0 for a brand-new document. */
  baseVersion: z.number().int().min(0),
  kind: z.enum(['autosave', 'manual']).default('autosave'),
});

/** JSON with object keys sorted: Postgres jsonb does not keep key order. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

const EMPTY_DOC = { type: 'doc', content: [{ type: 'paragraph' }] };

export interface DocumentSummary {
  id: string;
  title: string;
  latestVersion: number;
  updatedAt: string;
}

export async function createDocument(
  database: Database,
  context: SanadProjectContext,
  input: unknown,
): Promise<DocumentSummary> {
  const parsed = createDocumentSchema.safeParse(input);
  if (!parsed.success) throw new SanadError('SANAD_INVALID_INPUT');
  return withSanadProject(database, context, true, async (tx) => {
    const [document] = await tx
      .insert(documents)
      .values({
        workspaceId: context.workspaceId,
        projectId: context.projectId,
        title: parsed.data.title,
        createdBy: context.userId,
      })
      .returning();
    if (document === undefined) throw new SanadError('SANAD_INVALID_INPUT');
    await tx.insert(documentVersions).values({
      workspaceId: context.workspaceId,
      documentId: document.id,
      version: 1,
      kind: 'manual',
      content: EMPTY_DOC,
      createdBy: context.userId,
    });
    await tx.insert(auditLog).values({
      workspaceId: context.workspaceId,
      actorUserId: context.userId,
      action: 'document.created',
      entityType: 'document',
      entityId: document.id,
      metadata: {},
    });
    return {
      id: document.id,
      title: document.title,
      latestVersion: 1,
      updatedAt: document.updatedAt.toISOString(),
    };
  });
}

export async function listDocuments(
  database: Database,
  context: SanadProjectContext,
): Promise<DocumentSummary[]> {
  return withSanadProject(database, context, false, async (tx) => {
    const rows = await tx
      .select({
        id: documents.id,
        title: documents.title,
        updatedAt: documents.updatedAt,
        latestVersion: max(documentVersions.version),
      })
      .from(documents)
      .innerJoin(
        documentVersions,
        and(
          eq(documentVersions.workspaceId, documents.workspaceId),
          eq(documentVersions.documentId, documents.id),
        ),
      )
      .where(
        and(
          eq(documents.workspaceId, context.workspaceId),
          eq(documents.projectId, context.projectId),
        ),
      )
      .groupBy(documents.id)
      .orderBy(desc(documents.updatedAt));
    return rows.map((row) => ({
      id: row.id,
      title: row.title,
      latestVersion: row.latestVersion ?? 1,
      updatedAt: row.updatedAt.toISOString(),
    }));
  });
}

async function requireDocument(
  tx: Parameters<Parameters<typeof withSanadProject>[3]>[0],
  context: SanadProjectContext,
  documentId: string,
  lock: boolean,
) {
  const query = tx
    .select({ id: documents.id, title: documents.title })
    .from(documents)
    .where(
      and(
        eq(documents.workspaceId, context.workspaceId),
        eq(documents.projectId, context.projectId),
        eq(documents.id, documentId),
      ),
    );
  const [document] = lock ? await query.for('update') : await query;
  if (document === undefined) throw new SanadError('SANAD_FILE_NOT_FOUND');
  return document;
}

export interface DocumentVersion {
  documentId: string;
  title: string;
  version: number;
  kind: 'autosave' | 'manual';
  content: Record<string, unknown>;
  createdAt: string;
}

/** The latest version, or a specific one. */
export async function getDocument(
  database: Database,
  context: SanadProjectContext,
  documentId: string,
  version?: number,
): Promise<DocumentVersion> {
  if (!z.uuid().safeParse(documentId).success) throw new SanadError('SANAD_INVALID_INPUT');
  return withSanadProject(database, context, false, async (tx) => {
    const document = await requireDocument(tx, context, documentId, false);
    const [row] = await tx
      .select()
      .from(documentVersions)
      .where(
        and(
          eq(documentVersions.workspaceId, context.workspaceId),
          eq(documentVersions.documentId, documentId),
          ...(version === undefined ? [] : [eq(documentVersions.version, version)]),
        ),
      )
      .orderBy(desc(documentVersions.version))
      .limit(1);
    if (row === undefined) throw new SanadError('SANAD_FILE_NOT_FOUND');
    return {
      documentId,
      title: document.title,
      version: row.version,
      kind: row.kind,
      content: row.content,
      createdAt: row.createdAt.toISOString(),
    };
  });
}

export async function listDocumentVersions(
  database: Database,
  context: SanadProjectContext,
  documentId: string,
) {
  if (!z.uuid().safeParse(documentId).success) throw new SanadError('SANAD_INVALID_INPUT');
  return withSanadProject(database, context, false, async (tx) => {
    await requireDocument(tx, context, documentId, false);
    const rows = await tx
      .select({
        version: documentVersions.version,
        kind: documentVersions.kind,
        createdAt: documentVersions.createdAt,
      })
      .from(documentVersions)
      .where(
        and(
          eq(documentVersions.workspaceId, context.workspaceId),
          eq(documentVersions.documentId, documentId),
        ),
      )
      .orderBy(desc(documentVersions.version))
      .limit(500);
    return rows.map((row) => ({ ...row, createdAt: row.createdAt.toISOString() }));
  });
}

/**
 * Saves a new version. Refused with SANAD_VERSION_CONFLICT when `baseVersion` is not the
 * latest version (another tab or collaborator saved in between). Saving content equal to
 * the latest version is a no-op that returns the latest version number.
 */
export async function saveDocument(
  database: Database,
  context: SanadProjectContext,
  documentId: string,
  input: unknown,
): Promise<{ version: number; unchanged: boolean }> {
  if (!z.uuid().safeParse(documentId).success) throw new SanadError('SANAD_INVALID_INPUT');
  const parsed = saveDocumentSchema.safeParse(input);
  if (!parsed.success) throw new SanadError('SANAD_INVALID_INPUT');
  const { content, baseVersion, kind } = parsed.data;
  return withSanadProject(database, context, true, async (tx) => {
    // The row lock serialises concurrent saves of one document.
    await requireDocument(tx, context, documentId, true);
    const [latest] = await tx
      .select({ version: documentVersions.version, content: documentVersions.content })
      .from(documentVersions)
      .where(
        and(
          eq(documentVersions.workspaceId, context.workspaceId),
          eq(documentVersions.documentId, documentId),
        ),
      )
      .orderBy(desc(documentVersions.version))
      .limit(1);
    const current = latest?.version ?? 0;
    if (baseVersion !== current) throw new SanadError('SANAD_VERSION_CONFLICT');
    if (latest !== undefined && canonicalJson(latest.content) === canonicalJson(content)) {
      return { version: current, unchanged: true };
    }
    const version = current + 1;
    await tx.insert(documentVersions).values({
      workspaceId: context.workspaceId,
      documentId,
      version,
      kind,
      content,
      createdBy: context.userId,
    });
    await tx
      .update(documents)
      .set({ updatedAt: new Date() })
      .where(and(eq(documents.workspaceId, context.workspaceId), eq(documents.id, documentId)));
    if (kind === 'manual') {
      await tx.insert(auditLog).values({
        workspaceId: context.workspaceId,
        actorUserId: context.userId,
        action: 'document.version_saved',
        entityType: 'document',
        entityId: documentId,
        metadata: { version },
      });
    }
    return { version, unchanged: false };
  });
}
