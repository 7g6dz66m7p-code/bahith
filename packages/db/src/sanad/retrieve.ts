import { and, asc, desc, eq, isNull, or, sql } from 'drizzle-orm';
import { z } from 'zod';

import type { Database } from '../client';
import { chunks, EMBEDDING_DIMENSIONS, files, projectSources, sources } from '../schema/index';
import { arabicTsQuery } from '../search';

import { sanadContextSchema, withSanadProject } from './access';
import { SanadError } from './errors';
import { rankSanadCandidates } from './ranking';

export const SANAD_CANDIDATE_LIMIT = 200;
/** Semantic-only matches must have positive cosine similarity of at least 0.1. */
export const SANAD_MIN_COSINE_SIMILARITY = 0.1;

const queryEmbeddingSchema = z.object({
  model: z.string().trim().min(1).max(200),
  values: z
    .array(z.number().min(-1e20).max(1e20))
    .length(EMBEDDING_DIMENSIONS)
    .refine((values) => values.some((value) => Math.fround(value) !== 0)),
});

export const sanadRetrieveSchema = sanadContextSchema.extend({
  query: z.string().trim().min(1).max(2000),
  limit: z.number().int().min(1).max(50).default(10),
  queryEmbedding: queryEmbeddingSchema.optional(),
});

export type SanadRetrieveInput = z.input<typeof sanadRetrieveSchema>;

const selection = {
  id: chunks.id,
  workspaceId: chunks.workspaceId,
  sourceId: chunks.sourceId,
  fileId: chunks.fileId,
  fileSha256: files.sha256,
  extraction: files.extraction,
  provenance: chunks.provenance,
  content: chunks.content,
  kind: chunks.kind,
  pageStart: chunks.pageStart,
  pageEnd: chunks.pageEnd,
  locator: chunks.locator,
  chunkIndex: chunks.chunkIndex,
  sourceTitle: sources.title,
  sourceAuthors: sources.authors,
  sourceYear: sources.year,
  sourceDoi: sources.doi,
  sourceUrl: sources.url,
  verificationStatus: sources.verificationStatus,
  verificationProvider: sources.verificationProvider,
  verifiedAt: sources.verifiedAt,
  fullTextStatus: sources.fullTextStatus,
};

/**
 * Internal, project-scoped retrieval. No embedding is fabricated: without a supplied
 * real query embedding the response explicitly reports lexical-only retrieval.
 * Both candidate paths enforce project association as well as workspace RLS.
 */
export async function retrieve(database: Database, input: SanadRetrieveInput) {
  const parsed = sanadRetrieveSchema.safeParse(input);
  if (!parsed.success) {
    throw new SanadError('SANAD_INVALID_INPUT', 'Invalid SANAD retrieval input.');
  }
  const { workspaceId, projectId, query, limit, queryEmbedding } = parsed.data;
  return withSanadProject(database, parsed.data, false, async (tx) => {
    const tsQuery = arabicTsQuery(query);
    const lexicalRelevance = sql<number>`ts_rank_cd(${chunks.tsv}, ${tsQuery})`;
    const scope = and(
      eq(chunks.workspaceId, workspaceId),
      eq(projectSources.workspaceId, workspaceId),
      eq(projectSources.projectId, projectId),
      or(isNull(chunks.fileId), eq(files.status, 'ready')),
    );
    const fromProject = () =>
      tx
        .select({ ...selection, lexicalRelevance })
        .from(chunks)
        .innerJoin(
          projectSources,
          and(
            eq(projectSources.workspaceId, chunks.workspaceId),
            eq(projectSources.sourceId, chunks.sourceId),
          ),
        )
        .innerJoin(
          sources,
          and(eq(sources.workspaceId, chunks.workspaceId), eq(sources.id, chunks.sourceId)),
        )
        .leftJoin(
          files,
          and(
            eq(files.workspaceId, chunks.workspaceId),
            eq(files.id, chunks.fileId),
            eq(files.sourceId, chunks.sourceId),
          ),
        );
    const lexical = await fromProject()
      .where(and(scope, sql`${chunks.tsv} @@ ${tsQuery}`))
      .orderBy(desc(lexicalRelevance), asc(chunks.id))
      .limit(SANAD_CANDIDATE_LIMIT);
    let semantic: typeof lexical = [];
    if (queryEmbedding !== undefined) {
      const vector = `[${queryEmbedding.values.join(',')}]`;
      const distance = sql<number>`${chunks.embedding} <=> ${vector}::vector`;
      semantic = await fromProject()
        .where(
          and(
            scope,
            eq(chunks.embeddingModel, queryEmbedding.model),
            sql`${chunks.embedding} is not null`,
            sql`${distance} <= ${1 - SANAD_MIN_COSINE_SIMILARITY}`,
          ),
        )
        .orderBy(asc(distance), asc(chunks.id))
        .limit(SANAD_CANDIDATE_LIMIT);
    }
    const candidates = new Map([...lexical, ...semantic].map((row) => [row.id, row]));
    const ranking = rankSanadCandidates(
      lexical.map((row) => ({ id: row.id, relevance: row.lexicalRelevance })),
      semantic.map((row) => row.id),
    );
    return {
      mode: queryEmbedding === undefined ? ('lexical' as const) : ('hybrid' as const),
      ranking: 'rrf-60-lexical-tiebreak-v1' as const,
      minimumCosineSimilarity: queryEmbedding === undefined ? null : SANAD_MIN_COSINE_SIMILARITY,
      results: ranking.slice(0, limit).map((rank) => {
        const candidate = candidates.get(rank.id);
        if (candidate === undefined) {
          throw new SanadError('SANAD_INVALID_INPUT', 'The ranked candidate is unavailable.');
        }
        return {
          ...candidate,
          chunkId: candidate.id,
          pageStart: candidate.kind === 'abstract' ? null : candidate.pageStart,
          pageEnd: candidate.kind === 'abstract' ? null : candidate.pageEnd,
          locator: candidate.kind === 'abstract' ? null : candidate.locator,
          ...rank,
        };
      }),
    };
  });
}

export type SanadRetrieveResult = Awaited<ReturnType<typeof retrieve>>;
export type SanadEvidence = SanadRetrieveResult['results'][number];
