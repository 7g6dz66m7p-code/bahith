import type { SQL } from 'drizzle-orm';
import { sql } from 'drizzle-orm';

/**
 * Builds the tsquery for a user search string with the same Arabic normalisation that
 * is applied to `chunks.tsv`, so "الإحصاء", "الاحصاء" and "الْإِحْصَاء" all match.
 * The query text is always passed as a bound parameter.
 */
export function arabicTsQuery(query: string): SQL {
  return sql`websearch_to_tsquery('simple', app.normalize_arabic(${query}))`;
}

/**
 * Lexical retrieval v2 (ADR-0010). One tsquery per distinct non-stopword query term,
 * each matching the term, its Arabic light stem or its English stem in `chunks.tsv`.
 */
export function searchTermQueries(query: string): SQL {
  return sql`app.search_term_queries(${query})`;
}

/** Share of the query's terms a passage must match (minimum should match). */
export const LEXICAL_MIN_TERM_SHARE = 0.5;
