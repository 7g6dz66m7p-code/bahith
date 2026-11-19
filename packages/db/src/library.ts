import { and, asc, count, desc, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';

import type { Database } from './client';
import { auditLog, chunks, files, projectSources, sources } from './schema/index';
import type { SanadProjectContext } from './sanad/access';
import { withSanadProject } from './sanad/access';
import { SanadError } from './sanad/errors';
import { EXTRACTABLE_MIME_TYPES } from './sanad/manifest';

/**
 * The research library: uploaded sources, their stored files and processing state.
 *
 * Every function authorizes the acting user inside the same transaction (membership,
 * role and project), on top of row-level security. userId always comes from the
 * authenticated server session, never from a request body.
 */

export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

const PG_UNIQUE_VIOLATION = '23505';

export const registerUploadSchema = z.strictObject({
  /** Chosen by the caller before storing the bytes, so the object key is known. */
  fileId: z.uuid(),
  originalName: z.string().trim().min(1).max(255),
  mimeType: z.enum(EXTRACTABLE_MIME_TYPES),
  sizeBytes: z.number().int().min(1).max(MAX_UPLOAD_BYTES),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  storageKey: z.string().min(1).max(512),
});

export type RegisterUploadInput = z.infer<typeof registerUploadSchema>;

export interface RegisteredUpload {
  fileId: string;
  sourceId: string;
  storageKey: string;
  status: (typeof files.$inferSelect)['status'];
  /** True when identical bytes were already in this workspace (nothing new was stored). */
  duplicate: boolean;
}

function isUniqueViolation(error: unknown): boolean {
  for (const candidate of [error, error instanceof Error ? error.cause : undefined]) {
    const parsed = z.object({ code: z.string() }).safeParse(candidate);
    if (parsed.success) return parsed.data.code === PG_UNIQUE_VIOLATION;
  }
  return false;
}

/** A readable default title from a file name; the researcher can correct it later. */
export function titleFromFilename(name: string): string {
  const base = name
    .replace(/\.[^./\\]{1,8}$/u, '')
    .replace(/[_]+/gu, ' ')
    .trim();
  return base === '' ? name : base;
}

async function attachExisting(
  database: Database,
  context: SanadProjectContext,
  sha256: string,
): Promise<RegisteredUpload | null> {
  return withSanadProject(database, context, true, async (tx) => {
    const [existing] = await tx
      .select({
        id: files.id,
        sourceId: files.sourceId,
        storageKey: files.storageKey,
        status: files.status,
      })
      .from(files)
      .where(and(eq(files.workspaceId, context.workspaceId), eq(files.sha256, sha256)))
      .limit(1);
    if (existing?.sourceId == null) return null;
    await tx
      .insert(projectSources)
      .values({
        workspaceId: context.workspaceId,
        projectId: context.projectId,
        sourceId: existing.sourceId,
        addedBy: context.userId,
      })
      .onConflictDoNothing();
    return {
      fileId: existing.id,
      sourceId: existing.sourceId,
      storageKey: existing.storageKey,
      status: existing.status,
      duplicate: true,
    };
  });
}

/**
 * Records an upload: a new source, its file version and the project link — or, when the
 * same bytes (same SHA-256) are already in the workspace, links the existing source to
 * the project instead. Callers store the bytes under `storageKey` first; if this returns
 * `duplicate: true` the freshly stored object is redundant and can be deleted.
 */
export async function registerUpload(
  database: Database,
  context: SanadProjectContext,
  input: unknown,
): Promise<RegisteredUpload> {
  const parsed = registerUploadSchema.safeParse(input);
  if (!parsed.success) throw new SanadError('SANAD_INVALID_INPUT');
  const upload = parsed.data;

  const existing = await attachExisting(database, context, upload.sha256);
  if (existing !== null) return existing;

  try {
    return await withSanadProject(database, context, true, async (tx) => {
      const [source] = await tx
        .insert(sources)
        .values({
          workspaceId: context.workspaceId,
          origin: 'upload',
          // CSL item type; the researcher sets the precise type when completing metadata.
          type: 'document',
          title: titleFromFilename(upload.originalName),
          createdBy: context.userId,
        })
        .returning({ id: sources.id });
      if (source === undefined) throw new SanadError('SANAD_INVALID_INPUT');
      await tx.insert(files).values({
        id: upload.fileId,
        workspaceId: context.workspaceId,
        sourceId: source.id,
        storageKey: upload.storageKey,
        originalName: upload.originalName,
        mimeType: upload.mimeType,
        sizeBytes: upload.sizeBytes,
        sha256: upload.sha256,
        status: 'uploaded',
        uploadedBy: context.userId,
      });
      await tx.insert(projectSources).values({
        workspaceId: context.workspaceId,
        projectId: context.projectId,
        sourceId: source.id,
        addedBy: context.userId,
      });
      await tx.insert(auditLog).values({
        workspaceId: context.workspaceId,
        actorUserId: context.userId,
        action: 'source.uploaded',
        entityType: 'file',
        entityId: upload.fileId,
        metadata: { mimeType: upload.mimeType, sizeBytes: upload.sizeBytes },
      });
      return {
        fileId: upload.fileId,
        sourceId: source.id,
        storageKey: upload.storageKey,
        status: 'uploaded' as const,
        duplicate: false,
      };
    });
  } catch (error) {
    // Two identical uploads raced: the unique (workspace, sha256) index kept one.
    if (!isUniqueViolation(error)) throw error;
    const winner = await attachExisting(database, context, upload.sha256);
    if (winner === null) throw error;
    return winner;
  }
}

const fileCodeSchema = z.string().regex(/^[A-Z][A-Z0-9_]{0,79}$/);

async function loadProjectFile(
  database: Database,
  context: SanadProjectContext,
  fileId: string,
  write: boolean,
) {
  if (!z.uuid().safeParse(fileId).success) throw new SanadError('SANAD_INVALID_INPUT');
  return withSanadProject(database, context, write, async (tx) => {
    const [row] = await tx
      .select({
        id: files.id,
        sourceId: files.sourceId,
        storageKey: files.storageKey,
        mimeType: files.mimeType,
        originalName: files.originalName,
        sizeBytes: files.sizeBytes,
        sha256: files.sha256,
        status: files.status,
      })
      .from(files)
      .innerJoin(
        projectSources,
        and(
          eq(projectSources.workspaceId, files.workspaceId),
          eq(projectSources.sourceId, files.sourceId),
        ),
      )
      .where(
        and(
          eq(files.workspaceId, context.workspaceId),
          eq(files.id, fileId),
          eq(projectSources.projectId, context.projectId),
        ),
      )
      .limit(1);
    if (row === undefined) throw new SanadError('SANAD_FILE_NOT_FOUND');
    return row;
  });
}

/** A file the user may read through this project (for streaming it to the viewer). */
export function getProjectFile(database: Database, context: SanadProjectContext, fileId: string) {
  return loadProjectFile(database, context, fileId, false);
}

/** Moves a stored file into processing once its extraction job is queued. */
export async function markFileQueued(
  database: Database,
  context: SanadProjectContext,
  fileId: string,
): Promise<void> {
  await loadProjectFile(database, context, fileId, true);
  await withSanadProject(database, context, true, (tx) =>
    tx
      .update(files)
      .set({ status: 'processing', errorCode: null })
      .where(
        and(
          eq(files.workspaceId, context.workspaceId),
          eq(files.id, fileId),
          inArray(files.status, ['uploaded', 'failed']),
        ),
      ),
  );
}

/** Records a processing failure with a stable code (never a parser message). */
export async function markFileFailed(
  database: Database,
  context: SanadProjectContext,
  fileId: string,
  code: string,
): Promise<void> {
  const parsedCode = fileCodeSchema.safeParse(code);
  if (!parsedCode.success) throw new SanadError('SANAD_INVALID_INPUT');
  await loadProjectFile(database, context, fileId, true);
  await withSanadProject(database, context, true, async (tx) => {
    await tx
      .update(files)
      .set({ status: 'failed', errorCode: parsedCode.data })
      .where(
        and(
          eq(files.workspaceId, context.workspaceId),
          eq(files.id, fileId),
          inArray(files.status, ['uploaded', 'processing']),
        ),
      );
    await tx.insert(auditLog).values({
      workspaceId: context.workspaceId,
      actorUserId: context.userId,
      action: 'source.processing_failed',
      entityType: 'file',
      entityId: fileId,
      metadata: { code: parsedCode.data },
    });
  });
}

export interface LibraryEntry {
  sourceId: string;
  title: string;
  type: string;
  doi: string | null;
  year: number | null;
  verificationStatus: string;
  fullTextStatus: string;
  addedAt: string;
  files: {
    id: string;
    originalName: string;
    mimeType: string;
    sizeBytes: number;
    status: string;
    errorCode: string | null;
    pageCount: number | null;
    chunkCount: number;
    ocrUsed: boolean;
    failureCount: number;
  }[];
}

/** The sources of one project with the processing state of each stored file. */
export async function listProjectLibrary(
  database: Database,
  context: SanadProjectContext,
): Promise<LibraryEntry[]> {
  return withSanadProject(database, context, false, async (tx) => {
    const rows = await tx
      .select({
        sourceId: sources.id,
        title: sources.title,
        type: sources.type,
        doi: sources.doi,
        year: sources.year,
        verificationStatus: sources.verificationStatus,
        fullTextStatus: sources.fullTextStatus,
        addedAt: projectSources.createdAt,
      })
      .from(projectSources)
      .innerJoin(
        sources,
        and(
          eq(sources.workspaceId, projectSources.workspaceId),
          eq(sources.id, projectSources.sourceId),
        ),
      )
      .where(
        and(
          eq(projectSources.workspaceId, context.workspaceId),
          eq(projectSources.projectId, context.projectId),
        ),
      )
      .orderBy(desc(projectSources.createdAt));
    if (rows.length === 0) return [];

    const sourceIds = rows.map((row) => row.sourceId);
    const fileRows = await tx
      .select({
        id: files.id,
        sourceId: files.sourceId,
        originalName: files.originalName,
        mimeType: files.mimeType,
        sizeBytes: files.sizeBytes,
        status: files.status,
        errorCode: files.errorCode,
        pageCount: files.pageCount,
        extraction: files.extraction,
      })
      .from(files)
      .where(and(eq(files.workspaceId, context.workspaceId), inArray(files.sourceId, sourceIds)))
      .orderBy(asc(files.createdAt));
    const chunkCounts = await tx
      .select({ fileId: chunks.fileId, value: count() })
      .from(chunks)
      .where(and(eq(chunks.workspaceId, context.workspaceId), inArray(chunks.sourceId, sourceIds)))
      .groupBy(chunks.fileId);
    const countByFile = new Map(chunkCounts.map((row) => [row.fileId, row.value]));

    return rows.map((row) => ({
      ...row,
      addedAt: row.addedAt.toISOString(),
      files: fileRows
        .filter((file) => file.sourceId === row.sourceId)
        .map((file) => ({
          id: file.id,
          originalName: file.originalName,
          mimeType: file.mimeType,
          sizeBytes: file.sizeBytes,
          status: file.status,
          errorCode: file.errorCode,
          pageCount: file.pageCount,
          chunkCount: countByFile.get(file.id) ?? 0,
          ocrUsed: file.extraction?.extractorVersion.includes('+ocr-') ?? false,
          failureCount: file.extraction?.failures.length ?? 0,
        })),
    }));
  });
}
