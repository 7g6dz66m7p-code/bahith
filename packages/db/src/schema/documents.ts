import {
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';

import { createdAt, id, tenantExtras, updatedAt } from './_shared';
import {
  citationStatusEnum,
  documentVersionKindEnum,
  exportFormatEnum,
  exportStatusEnum,
} from './enums';
import { userRef, workspaceIdColumn } from './identity';
import { projects } from './projects';
import { chunks, sources } from './sources';

export const documents = pgTable(
  'documents',
  {
    id: id(),
    workspaceId: workspaceIdColumn(),
    projectId: uuid('project_id').notNull(),
    title: text('title').notNull(),
    createdBy: userRef('created_by'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    ...tenantExtras('documents', t),
    index('documents_project_id_idx').on(t.workspaceId, t.projectId),
    foreignKey({
      name: 'documents_project_fk',
      columns: [t.workspaceId, t.projectId],
      foreignColumns: [projects.workspaceId, projects.id],
    }).onDelete('cascade'),
  ],
);

/** Immutable snapshot of a document (ProseMirror JSON). The latest version is the current one. */
export const documentVersions = pgTable(
  'document_versions',
  {
    id: id(),
    workspaceId: workspaceIdColumn(),
    documentId: uuid('document_id').notNull(),
    version: integer('version').notNull(),
    kind: documentVersionKindEnum('kind').notNull().default('autosave'),
    content: jsonb('content').$type<Record<string, unknown>>().notNull(),
    createdBy: userRef('created_by'),
    createdAt: createdAt(),
  },
  (t) => [
    ...tenantExtras('document_versions', t),
    unique('document_versions_document_id_version_key').on(t.documentId, t.version),
    foreignKey({
      name: 'document_versions_document_fk',
      columns: [t.workspaceId, t.documentId],
      foreignColumns: [documents.workspaceId, documents.id],
    }).onDelete('cascade'),
  ],
);

/**
 * An in-text citation inside a document. The formatted text is produced by citeproc
 * from the `sources` row; `chunk_id` (when present) is where the page comes from.
 */
export const citations = pgTable(
  'citations',
  {
    id: id(),
    workspaceId: workspaceIdColumn(),
    documentId: uuid('document_id').notNull(),
    sourceId: uuid('source_id').notNull(),
    chunkId: uuid('chunk_id'),
    /** CSL locator entered by the researcher (e.g. a page range). */
    locator: text('locator'),
    prefix: text('prefix'),
    suffix: text('suffix'),
    status: citationStatusEnum('status').notNull().default('unconfirmed'),
    createdBy: userRef('created_by'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    ...tenantExtras('citations', t),
    index('citations_document_id_idx').on(t.workspaceId, t.documentId),
    index('citations_source_id_idx').on(t.workspaceId, t.sourceId),
    foreignKey({
      name: 'citations_document_fk',
      columns: [t.workspaceId, t.documentId],
      foreignColumns: [documents.workspaceId, documents.id],
    }).onDelete('cascade'),
    // No cascade: a cited source cannot be deleted from under a document.
    foreignKey({
      name: 'citations_source_fk',
      columns: [t.workspaceId, t.sourceId],
      foreignColumns: [sources.workspaceId, sources.id],
    }),
    foreignKey({
      name: 'citations_chunk_fk',
      columns: [t.workspaceId, t.chunkId],
      foreignColumns: [chunks.workspaceId, chunks.id],
    }),
  ],
);

/** One cell of the literature matrix: extracted text, its evidence, and human confirmation. */
export interface MatrixCell {
  text: string | null;
  /** Chunks the extraction is based on; validated against the workspace on write. */
  evidenceChunkIds: string[];
  status: 'pending' | 'confirmed' | 'rejected' | 'not_found';
  confirmedBy: string | null;
  confirmedAt: string | null;
}

/** One source of a project in the literature matrix. */
export const literatureMatrixRows = pgTable(
  'literature_matrix_rows',
  {
    id: id(),
    workspaceId: workspaceIdColumn(),
    projectId: uuid('project_id').notNull(),
    sourceId: uuid('source_id').notNull(),
    objective: jsonb('objective').$type<MatrixCell>(),
    method: jsonb('method').$type<MatrixCell>(),
    sample: jsonb('sample').$type<MatrixCell>(),
    findings: jsonb('findings').$type<MatrixCell>(),
    limitations: jsonb('limitations').$type<MatrixCell>(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    ...tenantExtras('literature_matrix_rows', t),
    unique('literature_matrix_rows_project_id_source_id_key').on(t.projectId, t.sourceId),
    foreignKey({
      name: 'literature_matrix_rows_project_fk',
      columns: [t.workspaceId, t.projectId],
      foreignColumns: [projects.workspaceId, projects.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'literature_matrix_rows_source_fk',
      columns: [t.workspaceId, t.sourceId],
      foreignColumns: [sources.workspaceId, sources.id],
    }).onDelete('cascade'),
  ],
);

export interface ExportWarning {
  code: string;
  count: number;
}

export const exports = pgTable(
  'exports',
  {
    id: id(),
    workspaceId: workspaceIdColumn(),
    documentId: uuid('document_id').notNull(),
    documentVersionId: uuid('document_version_id').notNull(),
    format: exportFormatEnum('format').notNull(),
    status: exportStatusEnum('status').notNull().default('pending'),
    storageKey: text('storage_key'),
    warnings: jsonb('warnings').$type<ExportWarning[]>().notNull().default([]),
    errorCode: text('error_code'),
    requestedBy: userRef('requested_by'),
    createdAt: createdAt(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
  },
  (t) => [
    ...tenantExtras('exports', t),
    index('exports_document_id_idx').on(t.workspaceId, t.documentId),
    foreignKey({
      name: 'exports_document_fk',
      columns: [t.workspaceId, t.documentId],
      foreignColumns: [documents.workspaceId, documents.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'exports_document_version_fk',
      columns: [t.workspaceId, t.documentVersionId],
      foreignColumns: [documentVersions.workspaceId, documentVersions.id],
    }).onDelete('cascade'),
  ],
);
