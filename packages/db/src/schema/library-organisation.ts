import { sql } from 'drizzle-orm';
import {
  check,
  foreignKey,
  index,
  integer,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { createdAt, id, tenantExtras, tenantPolicy, updatedAt } from './_shared';
import { userRef, workspaceIdColumn } from './identity';
import { projects } from './projects';
import { chunks, sources } from './sources';

/**
 * Organising a project's library (migration 0011): named collections of sources, and
 * highlights with notes on stored passages. Self-contained so it can be reviewed and
 * rolled back on its own.
 */

/** The small fixed set of highlight colours the UI offers (labels live in messages). */
export const highlightColorEnum = pgEnum('highlight_color', ['yellow', 'green', 'blue', 'pink']);

export const COLLECTION_NAME_MAX = 120;
export const HIGHLIGHT_NOTE_MAX = 5000;

/** A named group of the project's sources ("Methodology", "Chapter 2", …). */
export const collections = pgTable(
  'collections',
  {
    id: id(),
    workspaceId: workspaceIdColumn(),
    projectId: uuid('project_id').notNull(),
    name: text('name').notNull(),
    createdBy: userRef('created_by'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    ...tenantExtras('collections', t),
    // One name per project, case-insensitively.
    uniqueIndex('collections_project_id_name_key').on(t.projectId, sql`lower(${t.name})`),
    index('collections_project_id_idx').on(t.workspaceId, t.projectId),
    check(
      'collections_name_length',
      sql`char_length(btrim(${t.name})) between 1 and ${sql.raw(String(COLLECTION_NAME_MAX))}`,
    ),
    foreignKey({
      name: 'collections_project_fk',
      columns: [t.workspaceId, t.projectId],
      foreignColumns: [projects.workspaceId, projects.id],
    }).onDelete('cascade'),
  ],
);

/**
 * Membership of a source in a collection. The service only adds sources attached to the
 * collection's project; the composite keys keep both ends inside one workspace.
 */
export const collectionSources = pgTable(
  'collection_sources',
  {
    workspaceId: workspaceIdColumn(),
    collectionId: uuid('collection_id').notNull(),
    sourceId: uuid('source_id').notNull(),
    addedBy: userRef('added_by'),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ name: 'collection_sources_pkey', columns: [t.collectionId, t.sourceId] }),
    tenantPolicy('collection_sources'),
    index('collection_sources_source_id_idx').on(t.workspaceId, t.sourceId),
    foreignKey({
      name: 'collection_sources_collection_fk',
      columns: [t.workspaceId, t.collectionId],
      foreignColumns: [collections.workspaceId, collections.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'collection_sources_source_fk',
      columns: [t.workspaceId, t.sourceId],
      foreignColumns: [sources.workspaceId, sources.id],
    }).onDelete('cascade'),
  ],
);

/**
 * A highlighted span of a stored passage with an optional note. Offsets are Unicode code
 * points into `chunks.content`; `quote` is that exact substring (checked by the service
 * against the stored passage, and its length by the database). Pages always come from the
 * chunk row, never from the highlight.
 */
export const highlights = pgTable(
  'highlights',
  {
    id: id(),
    workspaceId: workspaceIdColumn(),
    projectId: uuid('project_id').notNull(),
    chunkId: uuid('chunk_id').notNull(),
    charStart: integer('char_start').notNull(),
    charEnd: integer('char_end').notNull(),
    quote: text('quote').notNull(),
    note: text('note'),
    color: highlightColorEnum('color').notNull().default('yellow'),
    createdBy: userRef('created_by'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    ...tenantExtras('highlights', t),
    index('highlights_project_id_idx').on(t.workspaceId, t.projectId, t.createdAt),
    index('highlights_chunk_id_idx').on(t.workspaceId, t.chunkId),
    check('highlights_offsets_valid', sql`${t.charStart} >= 0 and ${t.charEnd} > ${t.charStart}`),
    // Postgres counts characters (code points) in UTF-8, like the service.
    check(
      'highlights_quote_matches_offsets',
      sql`char_length(${t.quote}) = ${t.charEnd} - ${t.charStart}`,
    ),
    check(
      'highlights_note_length',
      sql`${t.note} is null or char_length(${t.note}) <= ${sql.raw(String(HIGHLIGHT_NOTE_MAX))}`,
    ),
    foreignKey({
      name: 'highlights_project_fk',
      columns: [t.workspaceId, t.projectId],
      foreignColumns: [projects.workspaceId, projects.id],
    }).onDelete('cascade'),
    // Chunks are never rewritten (a new extraction is a new file version), so a highlight
    // goes only with its passage's file or source.
    foreignKey({
      name: 'highlights_chunk_fk',
      columns: [t.workspaceId, t.chunkId],
      foreignColumns: [chunks.workspaceId, chunks.id],
    }).onDelete('cascade'),
  ],
);
