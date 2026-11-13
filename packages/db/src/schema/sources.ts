import { sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import {
  bigint,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  vector,
} from 'drizzle-orm/pg-core';

import {
  createdAt,
  EMBEDDING_DIMENSIONS,
  id,
  tenantExtras,
  tenantPolicy,
  tsvector,
  updatedAt,
} from './_shared';
import {
  chunkKindEnum,
  fileStatusEnum,
  sourceFullTextStatusEnum,
  sourceOriginEnum,
  sourceVerificationStatusEnum,
} from './enums';
import { userRef, workspaceIdColumn } from './identity';
import { projects } from './projects';

/** A CSL-JSON name (https://docs.citationstyles.org). */
export interface CslName {
  family?: string;
  given?: string;
  literal?: string;
}

/**
 * Bibliographic record. References are always built by code from these rows
 * (never by a language model), and only once `verification_status = 'verified'`.
 */
export const sources = pgTable(
  'sources',
  {
    id: id(),
    workspaceId: workspaceIdColumn(),
    origin: sourceOriginEnum('origin').notNull(),
    /** CSL item type, e.g. `article-journal`, `book`, `thesis`. */
    type: text('type').notNull(),
    title: text('title').notNull(),
    authors: jsonb('authors').$type<CslName[]>().notNull().default([]),
    year: integer('year'),
    containerTitle: text('container_title'),
    publisher: text('publisher'),
    volume: text('volume'),
    issue: text('issue'),
    pages: text('pages'),
    doi: text('doi'),
    isbn: text('isbn'),
    url: text('url'),
    language: text('language'),
    abstract: text('abstract'),
    /** Complete CSL-JSON item as fetched/imported; the input of citeproc. */
    csl: jsonb('csl').$type<Record<string, unknown>>(),
    externalIds: jsonb('external_ids').$type<Record<string, string>>().notNull().default({}),
    verificationStatus: sourceVerificationStatusEnum('verification_status')
      .notNull()
      .default('unverified'),
    verificationProvider: text('verification_provider'),
    verifiedAt: timestamp('verified_at', { withTimezone: true }),
    fullTextStatus: sourceFullTextStatusEnum('full_text_status').notNull().default('none'),
    createdBy: userRef('created_by'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    ...tenantExtras('sources', t),
    index('sources_workspace_id_idx').on(t.workspaceId),
    uniqueIndex('sources_workspace_id_doi_key')
      .on(t.workspaceId, sql`lower(${t.doi})`)
      .where(sql`${t.doi} is not null`),
    check(
      'sources_verified_has_provider',
      sql`${t.verificationStatus} <> 'verified' or (${t.verificationProvider} is not null and ${t.verifiedAt} is not null)`,
    ),
  ],
);

export const projectSources = pgTable(
  'project_sources',
  {
    workspaceId: workspaceIdColumn(),
    projectId: uuid('project_id').notNull(),
    sourceId: uuid('source_id').notNull(),
    addedBy: userRef('added_by'),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ name: 'project_sources_pkey', columns: [t.projectId, t.sourceId] }),
    tenantPolicy('project_sources'),
    index('project_sources_source_id_idx').on(t.workspaceId, t.sourceId),
    foreignKey({
      name: 'project_sources_project_fk',
      columns: [t.workspaceId, t.projectId],
      foreignColumns: [projects.workspaceId, projects.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'project_sources_source_fk',
      columns: [t.workspaceId, t.sourceId],
      foreignColumns: [sources.workspaceId, sources.id],
    }).onDelete('cascade'),
  ],
);

/** An uploaded object in S3-compatible storage. The bytes never live in Postgres. */
export const files = pgTable(
  'files',
  {
    id: id(),
    workspaceId: workspaceIdColumn(),
    sourceId: uuid('source_id'),
    storageKey: text('storage_key').notNull(),
    originalName: text('original_name').notNull(),
    mimeType: text('mime_type').notNull(),
    sizeBytes: bigint('size_bytes', { mode: 'number' }).notNull(),
    sha256: text('sha256'),
    pageCount: integer('page_count'),
    status: fileStatusEnum('status').notNull().default('uploaded'),
    errorCode: text('error_code'),
    uploadedBy: userRef('uploaded_by'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    ...tenantExtras('files', t),
    unique('files_storage_key_key').on(t.storageKey),
    index('files_source_id_idx').on(t.workspaceId, t.sourceId),
    check('files_size_bytes_positive', sql`${t.sizeBytes} > 0`),
    foreignKey({
      name: 'files_source_fk',
      columns: [t.workspaceId, t.sourceId],
      foreignColumns: [sources.workspaceId, sources.id],
    }).onDelete('cascade'),
  ],
);

/** Rectangles of a chunk on its pages, used to highlight the passage in the PDF viewer. */
export interface ChunkLocator {
  rects: { page: number; x: number; y: number; width: number; height: number }[];
}

/**
 * A retrievable passage. Page numbers shown to the user always come from
 * `page_start` / `page_end` here, never from model output.
 */
export const chunks = pgTable(
  'chunks',
  {
    id: id(),
    workspaceId: workspaceIdColumn(),
    sourceId: uuid('source_id').notNull(),
    fileId: uuid('file_id'),
    kind: chunkKindEnum('kind').notNull().default('full_text'),
    chunkIndex: integer('chunk_index').notNull(),
    pageStart: integer('page_start'),
    pageEnd: integer('page_end'),
    content: text('content').notNull(),
    tokenCount: integer('token_count'),
    locator: jsonb('locator').$type<ChunkLocator>(),
    tsv: tsvector('tsv').generatedAlwaysAs(
      (): SQL => sql`to_tsvector('simple', app.normalize_arabic(${chunks.content}))`,
    ),
    embedding: vector('embedding', { dimensions: EMBEDDING_DIMENSIONS }),
    /** Which embedding model produced `embedding`; needed to re-embed safely. */
    embeddingModel: text('embedding_model'),
    createdAt: createdAt(),
  },
  (t) => [
    ...tenantExtras('chunks', t),
    index('chunks_source_id_idx').on(t.workspaceId, t.sourceId),
    index('chunks_file_id_idx').on(t.workspaceId, t.fileId),
    index('chunks_tsv_gin').using('gin', t.tsv),
    index('chunks_embedding_hnsw').using('hnsw', t.embedding.op('vector_cosine_ops')),
    check(
      'chunks_pages_valid',
      sql`(${t.pageStart} is null and ${t.pageEnd} is null) or (${t.pageStart} >= 1 and ${t.pageEnd} >= ${t.pageStart})`,
    ),
    // An abstract-only passage has no page and no file, so it can never be cited by page.
    check(
      'chunks_abstract_has_no_page',
      sql`${t.kind} <> 'abstract' or (${t.pageStart} is null and ${t.fileId} is null)`,
    ),
    check(
      'chunks_embedding_has_model',
      sql`${t.embedding} is null or ${t.embeddingModel} is not null`,
    ),
    foreignKey({
      name: 'chunks_source_fk',
      columns: [t.workspaceId, t.sourceId],
      foreignColumns: [sources.workspaceId, sources.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'chunks_file_fk',
      columns: [t.workspaceId, t.fileId],
      foreignColumns: [files.workspaceId, files.id],
    }).onDelete('cascade'),
  ],
);
