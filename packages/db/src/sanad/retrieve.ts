import { and, asc, desc, eq, isNull, or, sql } from 'drizzle-orm';
import { z } from 'zod';

import type { Database } from '../client';
import { chunks, EMBEDDING_DIMENSIONS, files, projectSources, sources } from '../schema/index';
import { LEXICAL_MIN_TERM_SHARE, searchTermQueries } from '../search';

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
    // Minimum-should-match over per-term queries (ADR-0010): a passage must match at
    // least half of the query's terms (by surface form or stem); relevance is the share
    // matched, with cover density only breaking ties within the same share.
    //
    // The per-term queries are computed ONCE here and then bound as a parameter. Written
    // inline, the IMMUTABLE function was folded by the planner at each of its ~10
    // occurrences: planning took ~10 ms per search against ~1 ms of execution.
    const prepared = await tx.execute(
      sql`with t as (select ${searchTermQueries(query)} as q)
          select q::text[] as terms,
                 (select coalesce(string_agg(x::text, ' | '), '') from unnest(t.q) as x) as any_term
          from t`,
    );
    const row = z
      .object({ terms: z.array(z.string()).nullable(), any_term: z.string() })
      .parse(prepared.rows[0]);
    const termList = row.terms ?? [];
    // One JSON parameter (Drizzle would spread a JS array into several parameters).
    const terms = sql`array(select jsonb_array_elements_text(${JSON.stringify(termList)}::jsonb)::tsquery)`;
    const anyTerm = sql`${row.any_term}::tsquery`;
    const matched = sql<number>`(select count(*) from unnest(${terms}) as t(q) where ${chunks.tsv} @@ t.q)`;
    const termCount = sql<number>`${termList.length}::int`;
    const lexicalRelevance = sql<number>`(${matched}::float8 / greatest(${termCount}, 1) + ts_rank_cd(${chunks.tsv}, ${anyTerm}, 32) * 0.01)`;
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
      .where(
        and(
          scope,
          sql`${termCount} > 0`,
          sql`${chunks.tsv} @@ ${anyTerm}`,
          sql`${matched} >= ceil(${termCount} * ${LEXICAL_MIN_TERM_SHARE}::float8)`,
        ),
      )
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
      ranking: 'rrf-60-lexical-v2-min-share-50' as const,
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
