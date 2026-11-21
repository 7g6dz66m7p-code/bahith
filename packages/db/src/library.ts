import { and, asc, count, desc, eq, inArray, sql } from 'drizzle-orm';
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

const auditInputSchema = z.strictObject({
  action: z.string().regex(/^[a-z_]+(\.[a-z_]+)+$/),
  entityType: z.string().regex(/^[a-z_]+$/),
  entityId: z.uuid(),
  /** Identifiers, codes and counts only — never research content. */
  metadata: z.record(z.string(), z.union([z.string().max(100), z.number(), z.boolean(), z.null()])),
});

/** Appends an audit entry for an action the user performed (or a job did for them). */
export async function recordProjectAudit(
  database: Database,
  context: SanadProjectContext,
  input: z.input<typeof auditInputSchema>,
): Promise<void> {
  const parsed = auditInputSchema.safeParse(input);
  if (!parsed.success) throw new SanadError('SANAD_INVALID_INPUT');
  await withSanadProject(database, context, false, async (tx) => {
    await tx.insert(auditLog).values({
      workspaceId: context.workspaceId,
      actorUserId: context.userId,
      ...parsed.data,
    });
  });
}

/** Bibliographic fields of a source, as stored. */
export interface SourceMetadata {
  sourceId: string;
  type: string;
  title: string;
  authors: { family?: string; given?: string; literal?: string }[];
  year: number | null;
  containerTitle: string | null;
  publisher: string | null;
  volume: string | null;
  issue: string | null;
  pages: string | null;
  doi: string | null;
  url: string | null;
  language: string | null;
  verificationStatus: string;
  verificationProvider: string | null;
}

const sourceColumns = {
  sourceId: sources.id,
  type: sources.type,
  title: sources.title,
  authors: sources.authors,
  year: sources.year,
  containerTitle: sources.containerTitle,
  publisher: sources.publisher,
  volume: sources.volume,
  issue: sources.issue,
  pages: sources.pages,
  doi: sources.doi,
  url: sources.url,
  language: sources.language,
  verificationStatus: sources.verificationStatus,
  verificationProvider: sources.verificationProvider,
};

/** The stored metadata of every source attached to the project (for export/verification). */
export async function listProjectSourceMetadata(
  database: Database,
  context: SanadProjectContext,
  sourceId?: string,
): Promise<SourceMetadata[]> {
  if (sourceId !== undefined && !z.uuid().safeParse(sourceId).success) {
    throw new SanadError('SANAD_INVALID_INPUT');
  }
  return withSanadProject(database, context, false, async (tx) => {
    const rows = await tx
      .select(sourceColumns)
      .from(sources)
      .innerJoin(
        projectSources,
        and(
          eq(projectSources.workspaceId, sources.workspaceId),
          eq(projectSources.sourceId, sources.id),
          eq(projectSources.projectId, context.projectId),
        ),
      )
      .where(
        and(
          eq(sources.workspaceId, context.workspaceId),
          ...(sourceId === undefined ? [] : [eq(sources.id, sourceId)]),
        ),
      )
      .orderBy(asc(sources.title));
    if (sourceId !== undefined && rows.length === 0) throw new SanadError('SANAD_SOURCE_MISMATCH');
    return rows;
  });
}

const nameSchema = z
  .object({
    family: z.string().max(200).optional(),
    given: z.string().max(200).optional(),
    literal: z.string().max(300).optional(),
  })
  .loose()
  .transform(({ family, given, literal }) => ({
    ...(family === undefined ? {} : { family }),
    ...(given === undefined ? {} : { given }),
    ...(literal === undefined ? {} : { literal }),
  }));

/** Registry metadata accepted for a source (normalised CSL-JSON fields). */
export const registryRecordSchema = z.object({
  type: z.string().min(1).max(64),
  title: z.string().trim().min(1).max(2000),
  authors: z.array(nameSchema).max(500).default([]),
  year: z.number().int().min(0).max(3000).nullable().default(null),
  containerTitle: z.string().max(1000).nullable().default(null),
  publisher: z.string().max(500).nullable().default(null),
  volume: z.string().max(64).nullable().default(null),
  issue: z.string().max(64).nullable().default(null),
  pages: z.string().max(64).nullable().default(null),
  doi: z.string().max(300).nullable().default(null),
  url: z.url().max(2000).nullable().default(null),
  language: z.string().max(35).nullable().default(null),
  abstract: z.string().max(20_000).nullable().default(null),
  csl: z.record(z.string(), z.unknown()).nullable().default(null),
});

export type RegistryRecord = z.input<typeof registryRecordSchema>;

const verificationOutcomeSchema = z.discriminatedUnion('status', [
  z.strictObject({
    status: z.literal('verified'),
    provider: z.string().regex(/^[a-z_]{2,40}$/),
    record: registryRecordSchema,
  }),
  z.strictObject({
    status: z.enum(['mismatch', 'not_found']),
    provider: z
      .string()
      .regex(/^[a-z_]{2,40}$/)
      .nullable(),
  }),
]);

/**
 * Records the result of checking a source against a scholarly registry.
 *
 * `verified` replaces the bibliographic fields with the registry's (the registry is the
 * authority for its own record) and stamps provider + time. `mismatch` / `not_found`
 * only change the status: the researcher's metadata is kept for correction. An
 * unverifiable check (registry unreachable) must not be recorded at all.
 */
export async function applySourceVerification(
  database: Database,
  context: SanadProjectContext,
  sourceId: string,
  outcome: unknown,
): Promise<void> {
  const parsed = verificationOutcomeSchema.safeParse(outcome);
  if (!parsed.success || !z.uuid().safeParse(sourceId).success) {
    throw new SanadError('SANAD_INVALID_INPUT');
  }
  const result = parsed.data;
  await listProjectSourceMetadata(database, context, sourceId);
  await withSanadProject(database, context, true, async (tx) => {
    const where = and(eq(sources.workspaceId, context.workspaceId), eq(sources.id, sourceId));
    if (result.status === 'verified') {
      const { record } = result;
      await tx
        .update(sources)
        .set({
          type: record.type,
          title: record.title,
          authors: record.authors,
          year: record.year,
          containerTitle: record.containerTitle,
          publisher: record.publisher,
          volume: record.volume,
          issue: record.issue,
          pages: record.pages,
          doi: record.doi,
          url: record.url,
          language: record.language,
          ...(record.abstract === null ? {} : { abstract: record.abstract }),
          ...(record.csl === null ? {} : { csl: record.csl }),
          verificationStatus: 'verified',
          verificationProvider: result.provider,
          verifiedAt: new Date(),
        })
        .where(where);
    } else {
      await tx
        .update(sources)
        .set({
          verificationStatus: result.status,
          verificationProvider: result.provider,
          verifiedAt: null,
        })
        .where(where);
    }
    await tx.insert(auditLog).values({
      workspaceId: context.workspaceId,
      actorUserId: context.userId,
      action: 'source.verification_checked',
      entityType: 'source',
      entityId: sourceId,
      metadata: { status: result.status, provider: result.provider },
    });
  });
}

/**
 * Adds a bibliographic record found in a registry (or imported from BibTeX/RIS) to the
 * project. A source with the same DOI already in the workspace is linked instead of
 * duplicated. `verifiedBy` is set only for records fetched from a registry by DOI.
 */
export async function addReferenceSource(
  database: Database,
  context: SanadProjectContext,
  input: { record: RegistryRecord; origin: 'search' | 'import'; verifiedBy: string | null },
): Promise<{ sourceId: string; duplicate: boolean }> {
  const record = registryRecordSchema.safeParse(input.record);
  if (!record.success) throw new SanadError('SANAD_INVALID_INPUT');
  const data = record.data;
  return withSanadProject(database, context, true, async (tx) => {
    if (data.doi !== null) {
      const [existing] = await tx
        .select({ id: sources.id })
        .from(sources)
        .where(
          and(
            eq(sources.workspaceId, context.workspaceId),
            sql`lower(${sources.doi}) = lower(${data.doi})`,
          ),
        )
        .limit(1);
      if (existing !== undefined) {
        await tx
          .insert(projectSources)
          .values({
            workspaceId: context.workspaceId,
            projectId: context.projectId,
            sourceId: existing.id,
            addedBy: context.userId,
          })
          .onConflictDoNothing();
        return { sourceId: existing.id, duplicate: true };
      }
    }
    const [source] = await tx
      .insert(sources)
      .values({
        workspaceId: context.workspaceId,
        origin: input.origin,
        type: data.type,
        title: data.title,
        authors: data.authors,
        year: data.year,
        containerTitle: data.containerTitle,
        publisher: data.publisher,
        volume: data.volume,
        issue: data.issue,
        pages: data.pages,
        doi: data.doi,
        url: data.url,
        language: data.language,
        abstract: data.abstract,
        csl: data.csl,
        // Metadata only: no full text was provided, so nothing is citable by page.
        fullTextStatus: data.abstract === null ? 'none' : 'abstract_only',
        ...(input.verifiedBy === null
          ? {}
          : {
              verificationStatus: 'verified' as const,
              verificationProvider: input.verifiedBy,
              verifiedAt: new Date(),
            }),
        createdBy: context.userId,
      })
      .returning({ id: sources.id });
    if (source === undefined) throw new SanadError('SANAD_INVALID_INPUT');
    await tx.insert(projectSources).values({
      workspaceId: context.workspaceId,
      projectId: context.projectId,
      sourceId: source.id,
      addedBy: context.userId,
    });
    await tx.insert(auditLog).values({
      workspaceId: context.workspaceId,
      actorUserId: context.userId,
      action: input.origin === 'import' ? 'source.imported' : 'source.added_from_registry',
      entityType: 'source',
      entityId: source.id,
      metadata: { verified: input.verifiedBy !== null },
    });
    return { sourceId: source.id, duplicate: false };
  });
}
