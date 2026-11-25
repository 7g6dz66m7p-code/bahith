import { and, eq, inArray, isNull, ne, or, sql } from 'drizzle-orm';
import { z } from 'zod';

import { AssistantError } from './assistant';
import type { Database } from './client';
import { chunks, files, projects, projectSources } from './schema/index';
import { EMBEDDING_DIMENSIONS } from './schema/_shared';
import type { SanadProjectContext } from './sanad/access';
import { withSanadProject } from './sanad/access';
import { SanadError } from './sanad/errors';

const modelSchema = z.string().trim().min(1).max(200);

async function requireConsent(
  tx: Parameters<Parameters<typeof withSanadProject>[3]>[0],
  context: SanadProjectContext,
) {
  const [project] = await tx
    .select({ consent: projects.aiConsentAt })
    .from(projects)
    .where(and(eq(projects.workspaceId, context.workspaceId), eq(projects.id, context.projectId)));
  if (project?.consent == null) throw new AssistantError('AI_CONSENT_REQUIRED');
}

/**
 * Passages of this project (from ready files, or abstracts) that have no vector from
 * `model` yet. Their text is about to be sent to the embedding provider, so the
 * project's AI consent is required.
 */
export async function listChunksToEmbed(
  database: Database,
  context: SanadProjectContext,
  model: string,
  limit: number,
): Promise<{ chunkId: string; content: string }[]> {
  const parsedModel = modelSchema.safeParse(model);
  if (!parsedModel.success || !Number.isInteger(limit) || limit < 1 || limit > 256) {
    throw new SanadError('SANAD_INVALID_INPUT');
  }
  return withSanadProject(database, context, true, async (tx) => {
    await requireConsent(tx, context);
    return tx
      .select({ chunkId: chunks.id, content: chunks.content })
      .from(chunks)
      .innerJoin(
        projectSources,
        and(
          eq(projectSources.workspaceId, chunks.workspaceId),
          eq(projectSources.sourceId, chunks.sourceId),
          eq(projectSources.projectId, context.projectId),
        ),
      )
      .leftJoin(files, and(eq(files.workspaceId, chunks.workspaceId), eq(files.id, chunks.fileId)))
      .where(
        and(
          eq(chunks.workspaceId, context.workspaceId),
          or(isNull(chunks.fileId), eq(files.status, 'ready')),
          or(
            isNull(chunks.embedding),
            isNull(chunks.embeddingModel),
            ne(chunks.embeddingModel, parsedModel.data),
          ),
        ),
      )
      .orderBy(chunks.id)
      .limit(limit);
  });
}

const storeSchema = z.strictObject({
  model: modelSchema,
  items: z
    .array(
      z.strictObject({
        chunkId: z.uuid(),
        vector: z
          .array(z.number())
          .length(EMBEDDING_DIMENSIONS)
          .refine((values) => values.some((value) => value !== 0)),
      }),
    )
    .min(1)
    .max(256),
});

/** Stores real provider vectors for passages of this project (never synthetic ones). */
export async function storeChunkEmbeddings(
  database: Database,
  context: SanadProjectContext,
  input: z.input<typeof storeSchema>,
): Promise<number> {
  const parsed = storeSchema.safeParse(input);
  if (!parsed.success) throw new SanadError('SANAD_INVALID_INPUT');
  return withSanadProject(database, context, true, async (tx) => {
    await requireConsent(tx, context);
    const ids = parsed.data.items.map((item) => item.chunkId);
    const allowed = await tx
      .select({ id: chunks.id })
      .from(chunks)
      .innerJoin(
        projectSources,
        and(
          eq(projectSources.workspaceId, chunks.workspaceId),
          eq(projectSources.sourceId, chunks.sourceId),
          eq(projectSources.projectId, context.projectId),
        ),
      )
      .where(and(eq(chunks.workspaceId, context.workspaceId), inArray(chunks.id, ids)));
    if (new Set(allowed.map((row) => row.id)).size !== new Set(ids).size) {
      throw new SanadError('SANAD_SOURCE_MISMATCH');
    }
    for (const item of parsed.data.items) {
      await tx
        .update(chunks)
        .set({
          embedding: item.vector,
          embeddingModel: parsed.data.model,
        })
        .where(and(eq(chunks.workspaceId, context.workspaceId), eq(chunks.id, item.chunkId)));
    }
    return parsed.data.items.length;
  });
}

/** Count of this project's passages with a vector from `model` (for status and tests). */
export async function countEmbeddedChunks(
  database: Database,
  context: SanadProjectContext,
  model: string,
): Promise<number> {
  return withSanadProject(database, context, false, async (tx) => {
    const [row] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(chunks)
      .innerJoin(
        projectSources,
        and(
          eq(projectSources.workspaceId, chunks.workspaceId),
          eq(projectSources.sourceId, chunks.sourceId),
          eq(projectSources.projectId, context.projectId),
        ),
      )
      .where(and(eq(chunks.workspaceId, context.workspaceId), eq(chunks.embeddingModel, model)));
    return row?.n ?? 0;
  });
}
