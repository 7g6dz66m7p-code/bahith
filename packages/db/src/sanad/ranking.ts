/** Reciprocal-rank fusion uses rank positions, not incompatible lexical/vector scales. */
export const RRF_OFFSET = 60;

export interface LexicalRank {
  id: string;
  relevance: number;
}

export interface SanadRanking {
  id: string;
  score: number;
  lexicalRank: number | null;
  semanticRank: number | null;
  lexicalRelevance: number;
}

/**
 * Deterministic reranking: RRF descending, lexical relevance descending, then id.
 * Scores express retrieval ordering only, never scientific truth or confidence.
 * Duplicate ids in either ranked list contribute only their first position.
 */
export function rankSanadCandidates(
  lexical: readonly LexicalRank[],
  semantic: readonly string[],
): SanadRanking[] {
  const ranked = new Map<string, SanadRanking>();
  const get = (id: string): SanadRanking => {
    const previous = ranked.get(id);
    if (previous !== undefined) return previous;
    const entry: SanadRanking = {
      id,
      score: 0,
      lexicalRank: null,
      semanticRank: null,
      lexicalRelevance: 0,
    };
    ranked.set(id, entry);
    return entry;
  };
  lexical.forEach((candidate, index) => {
    const entry = get(candidate.id);
    if (entry.lexicalRank !== null) return;
    entry.lexicalRank = index + 1;
    entry.lexicalRelevance = candidate.relevance;
    entry.score += 1 / (RRF_OFFSET + index + 1);
  });
  semantic.forEach((id, index) => {
    const entry = get(id);
    if (entry.semanticRank !== null) return;
    entry.semanticRank = index + 1;
    entry.score += 1 / (RRF_OFFSET + index + 1);
  });
  return [...ranked.values()].sort(
    (a, b) =>
      b.score - a.score ||
      b.lexicalRelevance - a.lexicalRelevance ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
}
