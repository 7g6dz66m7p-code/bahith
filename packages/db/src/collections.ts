import { and, asc, desc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';

import type { Database, Tx } from './client';
import type { SanadProjectContext } from './sanad/access';
import { withSanadProject } from './sanad/access';
import { SanadError } from './sanad/errors';
import {
  auditLog,
  chunks,
  collectionSources,
  collections,
  COLLECTION_NAME_MAX,
  HIGHLIGHT_NOTE_MAX,
  highlightColorEnum,
  highlights,
  projectSources,
  sources,
} from './schema/index';

/**
 * Organising a project's library: collections of sources, and highlights with notes on
 * stored passages.
 *
 * Every function authorizes the acting user inside the same transaction (membership,
 * role, project) on top of row-level security. Owners and editors organise; viewers and
 * supervisors read. userId always comes from the authenticated server session.
 */

const PG_UNIQUE_VIOLATION = '23505';

function isUniqueViolation(error: unknown): boolean {
  for (const candidate of [error, error instanceof Error ? error.cause : undefined]) {
    const parsed = z.object({ code: z.string() }).safeParse(candidate);
    if (parsed.success) return parsed.data.code === PG_UNIQUE_VIOLATION;
  }
  return false;
}

const uuid = z.uuid();

function requireId(value: string): string {
  const parsed = uuid.safeParse(value);
  if (!parsed.success) throw new SanadError('SANAD_INVALID_INPUT');
  return parsed.data;
}

/** Ids and codes only: names, quotes and notes are research content and stay out. */
async function audit(
  tx: Tx,
  context: SanadProjectContext,
  action: string,
  entityType: string,
  entityId: string,
  metadata: Record<string, string | number | boolean | null> = {},
): Promise<void> {
  await tx.insert(auditLog).values({
    workspaceId: context.workspaceId,
    actorUserId: context.userId,
    action,
    entityType,
    entityId,
    metadata: { projectId: context.projectId, ...metadata },
  });
}

// ---------------------------------------------------------------------------
// Collections
// ---------------------------------------------------------------------------

export const collectionNameSchema = z.strictObject({
  name: z.string().trim().min(1).max(COLLECTION_NAME_MAX),
});

export interface CollectionEntry {
  id: string;
  name: string;
  /** Sources of this collection that are attached to the project, newest first. */
  sourceIds: string[];
  sourceCount: number;
  createdAt: string;
}

/** The collection with this id in this project (locked for the rest of the transaction). */
async function loadCollection(tx: Tx, context: SanadProjectContext, collectionId: string) {
  const [row] = await tx
    .select({ id: collections.id })
    .from(collections)
    .where(
      and(
        eq(collections.workspaceId, context.workspaceId),
        eq(collections.projectId, context.projectId),
        eq(collections.id, collectionId),
      ),
    )
    .for('update');
  if (row === undefined) throw new SanadError('LIBRARY_NOT_FOUND');
  return row;
}

/** The project's collections with their (project-attached) sources. Any member. */
export async function listCollections(
  database: Database,
  context: SanadProjectContext,
): Promise<CollectionEntry[]> {
  return withSanadProject(database, context, 'read', async (tx) => {
    const rows = await tx
      .select({ id: collections.id, name: collections.name, createdAt: collections.createdAt })
      .from(collections)
      .where(
        and(
          eq(collections.workspaceId, context.workspaceId),
          eq(collections.projectId, context.projectId),
        ),
      )
      .orderBy(sql`lower(${collections.name})`, asc(collections.createdAt));
    if (rows.length === 0) return [];
    const members = await tx
      .select({
        collectionId: collectionSources.collectionId,
        sourceId: collectionSources.sourceId,
      })
      .from(collectionSources)
      .innerJoin(
        collections,
        and(
          eq(collections.workspaceId, collectionSources.workspaceId),
          eq(collections.id, collectionSources.collectionId),
        ),
      )
      .innerJoin(
        projectSources,
        and(
          eq(projectSources.workspaceId, collectionSources.workspaceId),
          eq(projectSources.sourceId, collectionSources.sourceId),
          eq(projectSources.projectId, collections.projectId),
        ),
      )
      .where(
        and(
          eq(collectionSources.workspaceId, context.workspaceId),
          eq(collections.projectId, context.projectId),
        ),
      )
      .orderBy(desc(collectionSources.createdAt));
    return rows.map((row) => {
      const sourceIds = members
        .filter((member) => member.collectionId === row.id)
        .map((member) => member.sourceId);
      return {
        id: row.id,
        name: row.name,
        sourceIds,
        sourceCount: sourceIds.length,
        createdAt: row.createdAt.toISOString(),
      };
    });
  });
}

/** Creates a collection (owner/editor). Names are unique per project, ignoring case. */
export async function createCollection(
  database: Database,
  context: SanadProjectContext,
  input: unknown,
): Promise<{ id: string; name: string }> {
  const parsed = collectionNameSchema.safeParse(input);
  if (!parsed.success) throw new SanadError('SANAD_INVALID_INPUT');
  try {
    return await withSanadProject(database, context, 'write', async (tx) => {
      const [row] = await tx
        .insert(collections)
        .values({
          workspaceId: context.workspaceId,
          projectId: context.projectId,
          name: parsed.data.name,
          createdBy: context.userId,
        })
        .returning({ id: collections.id, name: collections.name });
      if (row === undefined) throw new SanadError('SANAD_INVALID_INPUT');
      await audit(tx, context, 'collection.created', 'collection', row.id);
      return row;
    });
  } catch (error) {
    if (isUniqueViolation(error)) throw new SanadError('LIBRARY_NAME_TAKEN');
    throw error;
  }
}

/** Renames a collection of this project (owner/editor). */
export async function renameCollection(
  database: Database,
  context: SanadProjectContext,
  collectionId: string,
  input: unknown,
): Promise<{ id: string; name: string }> {
  const id = requireId(collectionId);
  const parsed = collectionNameSchema.safeParse(input);
  if (!parsed.success) throw new SanadError('SANAD_INVALID_INPUT');
  try {
    return await withSanadProject(database, context, 'write', async (tx) => {
      await loadCollection(tx, context, id);
      await tx
        .update(collections)
        .set({ name: parsed.data.name })
        .where(and(eq(collections.workspaceId, context.workspaceId), eq(collections.id, id)));
      await audit(tx, context, 'collection.renamed', 'collection', id);
      return { id, name: parsed.data.name };
    });
  } catch (error) {
    if (isUniqueViolation(error)) throw new SanadError('LIBRARY_NAME_TAKEN');
    throw error;
  }
}

/** Deletes a collection (owner/editor). Its sources stay in the project's library. */
export async function deleteCollection(
  database: Database,
  context: SanadProjectContext,
  collectionId: string,
): Promise<void> {
  const id = requireId(collectionId);
  await withSanadProject(database, context, 'write', async (tx) => {
    await loadCollection(tx, context, id);
    await tx
      .delete(collections)
      .where(and(eq(collections.workspaceId, context.workspaceId), eq(collections.id, id)));
    await audit(tx, context, 'collection.deleted', 'collection', id);
  });
}

/** Whether the source is attached to the context's project. */
async function requireProjectSource(
  tx: Tx,
  context: SanadProjectContext,
  sourceId: string,
): Promise<void> {
  const [attached] = await tx
    .select({ sourceId: projectSources.sourceId })
    .from(projectSources)
    .where(
      and(
        eq(projectSources.workspaceId, context.workspaceId),
        eq(projectSources.projectId, context.projectId),
        eq(projectSources.sourceId, sourceId),
      ),
    )
    .for('share');
  if (attached === undefined) throw new SanadError('SANAD_SOURCE_MISMATCH');
}

/**
 * Puts a source of the project's library into a collection (owner/editor). A source
 * that is not attached to this project is refused. Adding it twice changes nothing.
 */
export async function addSourceToCollection(
  database: Database,
  context: SanadProjectContext,
  collectionId: string,
  sourceId: string,
): Promise<{ added: boolean }> {
  const collection = requireId(collectionId);
  const source = requireId(sourceId);
  return withSanadProject(database, context, 'write', async (tx) => {
    await loadCollection(tx, context, collection);
    await requireProjectSource(tx, context, source);
    const inserted = await tx
      .insert(collectionSources)
      .values({
        workspaceId: context.workspaceId,
        collectionId: collection,
        sourceId: source,
        addedBy: context.userId,
      })
      .onConflictDoNothing()
      .returning({ sourceId: collectionSources.sourceId });
    if (inserted.length > 0) {
      await audit(tx, context, 'collection.source_added', 'collection', collection, {
        sourceId: source,
      });
    }
    return { added: inserted.length > 0 };
  });
}

/** Takes a source out of a collection (owner/editor); the source stays in the library. */
export async function removeSourceFromCollection(
  database: Database,
  context: SanadProjectContext,
  collectionId: string,
  sourceId: string,
): Promise<{ removed: boolean }> {
  const collection = requireId(collectionId);
  const source = requireId(sourceId);
  return withSanadProject(database, context, 'write', async (tx) => {
    await loadCollection(tx, context, collection);
    const deleted = await tx
      .delete(collectionSources)
      .where(
        and(
          eq(collectionSources.workspaceId, context.workspaceId),
          eq(collectionSources.collectionId, collection),
          eq(collectionSources.sourceId, source),
        ),
      )
      .returning({ sourceId: collectionSources.sourceId });
    if (deleted.length > 0) {
      await audit(tx, context, 'collection.source_removed', 'collection', collection, {
        sourceId: source,
      });
    }
    return { removed: deleted.length > 0 };
  });
}

// ---------------------------------------------------------------------------
// Highlights
// ---------------------------------------------------------------------------

export const HIGHLIGHT_COLORS = highlightColorEnum.enumValues;
export type HighlightColor = (typeof HIGHLIGHT_COLORS)[number];

const noteSchema = z
  .string()
  .max(HIGHLIGHT_NOTE_MAX * 2)
  .nullable()
  .optional()
  .transform((value) => {
    const trimmed = value?.trim() ?? '';
    return trimmed === '' ? null : trimmed;
  })
  .refine((value) => value === null || Array.from(value).length <= HIGHLIGHT_NOTE_MAX);

export const addHighlightSchema = z.strictObject({
  chunkId: z.uuid(),
  /** Code-point offsets into the stored passage, end exclusive. */
  charStart: z.number().int().min(0),
  charEnd: z.number().int().min(1),
  /** Must be exactly the passage text between the offsets. */
  quote: z.string().min(1).max(20_000),
  note: noteSchema,
  color: z.enum(HIGHLIGHT_COLORS).default('yellow'),
});

export const updateHighlightSchema = z.strictObject({ note: noteSchema });

/**
 * The text of `content` between two code-point offsets (end exclusive), or null when the
 * offsets fall outside it. Offsets count Unicode code points, as `verifyQuotation` and
 * the chunk provenance do, so an Arabic letter, a diacritic or an emoji each count once
 * per code point regardless of UTF-16 surrogates.
 */
export function codePointSlice(content: string, start: number, end: number): string | null {
  const points = Array.from(content);
  if (start < 0 || end <= start || end > points.length) return null;
  return points.slice(start, end).join('');
}

export interface HighlightEntry {
  id: string;
  chunkId: string;
  sourceId: string;
  sourceTitle: string;
  fileId: string | null;
  /** From the stored passage, never from the request. */
  pageStart: number | null;
  pageEnd: number | null;
  charStart: number;
  charEnd: number;
  quote: string;
  note: string | null;
  color: HighlightColor;
  createdAt: string;
  updatedAt: string;
  /** What the acting user may do with this highlight. */
  canEditNote: boolean;
  canDelete: boolean;
}

/**
 * Highlights a span of a stored passage (owner/editor). The passage must belong to a
 * source attached to this project, and `quote` must be exactly its text between the
 * code-point offsets; anything else is refused, so a highlight can never misquote.
 */
export async function addHighlight(
  database: Database,
  context: SanadProjectContext,
  input: unknown,
): Promise<{ id: string }> {
  const parsed = addHighlightSchema.safeParse(input);
  if (!parsed.success || parsed.data.quote.trim() === '') {
    throw new SanadError('SANAD_INVALID_INPUT');
  }
  const data = parsed.data;
  return withSanadProject(database, context, 'write', async (tx) => {
    const [chunk] = await tx
      .select({ content: chunks.content })
      .from(chunks)
      .innerJoin(
        projectSources,
        and(
          eq(projectSources.workspaceId, chunks.workspaceId),
          eq(projectSources.sourceId, chunks.sourceId),
          eq(projectSources.projectId, context.projectId),
        ),
      )
      .where(and(eq(chunks.workspaceId, context.workspaceId), eq(chunks.id, data.chunkId)))
      .limit(1);
    if (chunk === undefined) throw new SanadError('LIBRARY_NOT_FOUND');
    if (codePointSlice(chunk.content, data.charStart, data.charEnd) !== data.quote) {
      throw new SanadError('HIGHLIGHT_QUOTE_MISMATCH');
    }
    const [row] = await tx
      .insert(highlights)
      .values({
        workspaceId: context.workspaceId,
        projectId: context.projectId,
        chunkId: data.chunkId,
        charStart: data.charStart,
        charEnd: data.charEnd,
        quote: data.quote,
        note: data.note,
        color: data.color,
        createdBy: context.userId,
      })
      .returning({ id: highlights.id });
    if (row === undefined) throw new SanadError('SANAD_INVALID_INPUT');
    await audit(tx, context, 'highlight.created', 'highlight', row.id, {
      chunkId: data.chunkId,
      hasNote: data.note !== null,
    });
    return { id: row.id };
  });
}

/** The project's highlights, newest first; optionally only those on one source. Any member. */
export async function listHighlights(
  database: Database,
  context: SanadProjectContext,
  options: { sourceId?: string } = {},
): Promise<HighlightEntry[]> {
  const sourceId = options.sourceId === undefined ? undefined : requireId(options.sourceId);
  return withSanadProject(database, context, 'read', async (tx, role) => {
    const rows = await tx
      .select({
        id: highlights.id,
        chunkId: highlights.chunkId,
        sourceId: chunks.sourceId,
        sourceTitle: sources.title,
        fileId: chunks.fileId,
        pageStart: chunks.pageStart,
        pageEnd: chunks.pageEnd,
        charStart: highlights.charStart,
        charEnd: highlights.charEnd,
        quote: highlights.quote,
        note: highlights.note,
        color: highlights.color,
        createdBy: highlights.createdBy,
        createdAt: highlights.createdAt,
        updatedAt: highlights.updatedAt,
      })
      .from(highlights)
      .innerJoin(
        chunks,
        and(eq(chunks.workspaceId, highlights.workspaceId), eq(chunks.id, highlights.chunkId)),
      )
      .innerJoin(
        sources,
        and(eq(sources.workspaceId, chunks.workspaceId), eq(sources.id, chunks.sourceId)),
      )
      .innerJoin(
        projectSources,
        and(
          eq(projectSources.workspaceId, chunks.workspaceId),
          eq(projectSources.sourceId, chunks.sourceId),
          eq(projectSources.projectId, highlights.projectId),
        ),
      )
      .where(
        and(
          eq(highlights.workspaceId, context.workspaceId),
          eq(highlights.projectId, context.projectId),
          ...(sourceId === undefined ? [] : [eq(chunks.sourceId, sourceId)]),
        ),
      )
      .orderBy(desc(highlights.createdAt), asc(highlights.id));
    const writer = role === 'owner' || role === 'editor';
    return rows.map(({ createdBy, createdAt, updatedAt, ...row }) => ({
      ...row,
      createdAt: createdAt.toISOString(),
      updatedAt: updatedAt.toISOString(),
      canEditNote: writer && (createdBy === context.userId || role === 'owner'),
      canDelete: writer,
    }));
  });
}

async function loadHighlight(tx: Tx, context: SanadProjectContext, highlightId: string) {
  const [row] = await tx
    .select({ id: highlights.id, createdBy: highlights.createdBy })
    .from(highlights)
    .where(
      and(
        eq(highlights.workspaceId, context.workspaceId),
        eq(highlights.projectId, context.projectId),
        eq(highlights.id, highlightId),
      ),
    )
    .for('update');
  if (row === undefined) throw new SanadError('LIBRARY_NOT_FOUND');
  return row;
}

/**
 * Changes (or clears) the note of a highlight. A note belongs to its author: an editor
 * edits only their own; the owner may edit any. Viewers and supervisors cannot.
 */
export async function updateHighlightNote(
  database: Database,
  context: SanadProjectContext,
  highlightId: string,
  input: unknown,
): Promise<{ id: string; note: string | null }> {
  const id = requireId(highlightId);
  const parsed = updateHighlightSchema.safeParse(input);
  if (!parsed.success) throw new SanadError('SANAD_INVALID_INPUT');
  return withSanadProject(database, context, 'write', async (tx, role) => {
    const row = await loadHighlight(tx, context, id);
    if (row.createdBy !== context.userId && role !== 'owner') {
      throw new SanadError('SANAD_FORBIDDEN');
    }
    await tx
      .update(highlights)
      .set({ note: parsed.data.note })
      .where(and(eq(highlights.workspaceId, context.workspaceId), eq(highlights.id, id)));
    await audit(tx, context, 'highlight.note_updated', 'highlight', id, {
      hasNote: parsed.data.note !== null,
    });
    return { id, note: parsed.data.note };
  });
}

/** Deletes a highlight and its note (owner/editor). */
export async function deleteHighlight(
  database: Database,
  context: SanadProjectContext,
  highlightId: string,
): Promise<void> {
  const id = requireId(highlightId);
  await withSanadProject(database, context, 'write', async (tx) => {
    await loadHighlight(tx, context, id);
    await tx
      .delete(highlights)
      .where(and(eq(highlights.workspaceId, context.workspaceId), eq(highlights.id, id)));
    await audit(tx, context, 'highlight.deleted', 'highlight', id);
  });
}
