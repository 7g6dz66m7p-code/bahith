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
