import { createHash } from 'node:crypto';

import { and, asc, eq } from 'drizzle-orm';
import { z } from 'zod';

import type { Database } from '../client';
import { chunks, EMBEDDING_DIMENSIONS, files, projectSources, sources } from '../schema/index';

import type { SanadProjectContext } from './access';
import { withSanadProject } from './access';
import { SanadError } from './errors';
import { parseExtractionManifest } from './manifest';

const embeddingBatchSchema = z.strictObject({
  model: z.string().trim().min(1).max(200),
  vectors: z
    .array(
      z
        .array(z.number().min(-1e20).max(1e20))
        .length(EMBEDDING_DIMENSIONS)
        .refine((vector) => vector.some((value) => Math.fround(value) !== 0)),
    )
    .max(50_000),
});

export interface IngestExtractionInput extends SanadProjectContext {
  /** Must already belong to a source explicitly attached to this project. */
  fileId: string;
  manifest: unknown;
  /** Real, externally computed vectors only. No synthetic or default embeddings. */
  embeddings?: z.infer<typeof embeddingBatchSchema>;
}

/**
 * Trusted internal boundary, not an HTTP handler. The caller authenticates userId and
 * obtains the manifest from the extractor operating on the registered file bytes.
 * Writes are atomic and retries are idempotent. New bytes require a new file record.
 */
export async function ingestExtraction(database: Database, input: IngestExtractionInput) {
  if (!z.uuid().safeParse(input.fileId).success) throw new SanadError('SANAD_INVALID_INPUT');
  const manifest = parseExtractionManifest(input.manifest);
  const embeddingResult =
    input.embeddings === undefined ? undefined : embeddingBatchSchema.safeParse(input.embeddings);
  if (embeddingResult !== undefined && !embeddingResult.success) {
    throw new SanadError('SANAD_INVALID_INPUT');
  }
  const embeddings = embeddingResult?.data;
  if (embeddings !== undefined && embeddings.vectors.length !== manifest.chunks.length) {
    throw new SanadError('SANAD_INVALID_INPUT');
  }
  const manifestSha256 = createHash('sha256').update(JSON.stringify(manifest)).digest('hex');
  return withSanadProject(database, input, true, async (tx) => {
    const [file] = await tx
      .select()
      .from(files)
      .where(and(eq(files.workspaceId, input.workspaceId), eq(files.id, input.fileId)))
      .for('update');
    if (file === undefined) throw new SanadError('SANAD_FILE_NOT_FOUND');
    if (file.sourceId === null) throw new SanadError('SANAD_SOURCE_MISMATCH');
    const [attachment] = await tx
      .select({ sourceId: projectSources.sourceId })
      .from(projectSources)
      .where(
        and(
          eq(projectSources.workspaceId, input.workspaceId),
          eq(projectSources.projectId, input.projectId),
          eq(projectSources.sourceId, file.sourceId),
        ),
      )
      .for('share');
    if (attachment === undefined) throw new SanadError('SANAD_SOURCE_MISMATCH');
    if (
      file.mimeType !== manifest.mimeType ||
      (file.sha256 !== null && file.sha256 !== manifest.fileSha256)
    ) {
      throw new SanadError('SANAD_VERSION_CONFLICT');
    }
    if (file.extraction !== null) {
      if (file.extraction.manifestSha256 !== manifestSha256) {
        throw new SanadError('SANAD_VERSION_CONFLICT');
      }
      const stored = await tx
        .select({ id: chunks.id, index: chunks.chunkIndex })
        .from(chunks)
        .where(and(eq(chunks.workspaceId, input.workspaceId), eq(chunks.fileId, input.fileId)))
        .orderBy(asc(chunks.chunkIndex));
      if (
        stored.length !== file.extraction.chunkCount ||
        stored.some((chunk, index) => chunk.index !== index)
      ) {
        throw new SanadError('SANAD_VERSION_CONFLICT');
      }
      return {
        fileId: file.id,
        status: file.status,
        chunkIds: stored.map((chunk) => chunk.id),
        failures: file.extraction.failures,
        reused: true,
      };
    }
    // Never overwrite legacy/cited chunks. A new extraction gets a new file version.
    const [existing] = await tx
      .select({ id: chunks.id })
      .from(chunks)
      .where(and(eq(chunks.workspaceId, input.workspaceId), eq(chunks.fileId, input.fileId)))
      .limit(1);
    if (existing !== undefined) throw new SanadError('SANAD_VERSION_CONFLICT');
    const units = new Map(manifest.units.map((unit) => [unit.index, unit]));
    const chunkIds: string[] = [];
    // Bound INSERT size and Postgres parameter count for long documents.
    for (let offset = 0; offset < manifest.chunks.length; offset += 100) {
      const inserted = await tx
        .insert(chunks)
        .values(
          manifest.chunks.slice(offset, offset + 100).map((chunk) => ({
            workspaceId: input.workspaceId,
            sourceId: file.sourceId ?? '',
            fileId: file.id,
            kind: 'full_text' as const,
            chunkIndex: chunk.index,
            pageStart: chunk.pageStart,
            pageEnd: chunk.pageEnd,
            content: chunk.content,
            tokenCount: chunk.tokenCount,
            embedding: embeddings?.vectors[chunk.index],
            embeddingModel: embeddings?.model,
            provenance: {
              fileSha256: manifest.fileSha256,
              extractorVersion: manifest.extractorVersion,
              chunkerVersion: manifest.chunkerVersion,
              unitIndex: chunk.unitIndex,
              unitKind: units.get(chunk.unitIndex)?.kind ?? 'text',
              charStart: chunk.charStart,
              charEnd: chunk.charEnd,
              direction: chunk.direction,
            },
          })),
        )
        .returning({ id: chunks.id });
      chunkIds.push(...inserted.map((chunk) => chunk.id));
    }
    const status = chunkIds.length > 0 ? 'ready' : 'failed';
    await tx
      .update(files)
      .set({
        sha256: manifest.fileSha256,
        status,
        errorCode: status === 'failed' ? 'SANAD_NO_TEXT' : null,
        pageCount:
          manifest.mimeType === 'application/pdf'
            ? new Set(
                [
                  ...manifest.units.map((unit) => unit.page),
                  ...manifest.failures.map((failure) => failure.page),
                ].filter((page) => page !== null),
              ).size
            : null,
        extraction: {
          schemaVersion: 1,
          manifestSha256,
          extractorVersion: manifest.extractorVersion,
          chunkerVersion: manifest.chunkerVersion,
          unitCount: manifest.units.length,
          chunkCount: chunkIds.length,
          failures: manifest.failures,
        },
      })
      .where(and(eq(files.workspaceId, input.workspaceId), eq(files.id, file.id)));
    if (status === 'ready') {
      await tx
        .update(sources)
        .set({ fullTextStatus: 'full_text' })
        .where(and(eq(sources.workspaceId, input.workspaceId), eq(sources.id, file.sourceId)));
    }
    return { fileId: file.id, status, chunkIds, failures: manifest.failures, reused: false };
  });
}
