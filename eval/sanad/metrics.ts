/** Pure scoring for the SANAD evaluation; no database or I/O. */

export interface RetrievedPassage {
  sourceId: string;
  pageStart: number | null;
  pageEnd: number | null;
}

export interface Gold {
  sourceId: string;
  page: number;
}

/** A passage is on target when it is from the gold source and its stored page range covers the gold page. */
export function covers(passage: RetrievedPassage, gold: Gold): boolean {
  return (
    passage.sourceId === gold.sourceId &&
    passage.pageStart !== null &&
    passage.pageEnd !== null &&
    passage.pageStart <= gold.page &&
    gold.page <= passage.pageEnd
  );
}

/** 1-based rank of the first on-target passage, or null. */
export function firstHit(results: readonly RetrievedPassage[], gold: Gold): number | null {
  const index = results.findIndex((passage) => covers(passage, gold));
  return index === -1 ? null : index + 1;
}

export interface RetrievalScores {
  questions: number;
  recallAt1: number;
  recallAt10: number;
  mrr: number;
  /** Top result is on target and pinned to exactly the gold page (pageStart = pageEnd = gold). */
  exactPageAt1: number;
}

export function scoreRetrieval(
  cases: readonly { results: readonly RetrievedPassage[]; gold: Gold }[],
): RetrievalScores {
  const n = cases.length;
  if (n === 0) return { questions: 0, recallAt1: 0, recallAt10: 0, mrr: 0, exactPageAt1: 0 };
  let at1 = 0;
  let at10 = 0;
  let reciprocal = 0;
  let exact = 0;
  for (const { results, gold } of cases) {
    const rank = firstHit(results.slice(0, 10), gold);
    if (rank !== null) {
      at10 += 1;
      reciprocal += 1 / rank;
    }
    if (rank === 1) {
      at1 += 1;
      const top = results[0];
      if (top?.pageStart === gold.page && top.pageEnd === gold.page) exact += 1;
    }
  }
  return {
    questions: n,
    recallAt1: at1 / n,
    recallAt10: at10 / n,
    mrr: reciprocal / n,
    exactPageAt1: exact / n,
  };
}

const ARABIC_DIGITS = '٠١٢٣٤٥٦٧٨٩';

/**
 * Deterministic corruptions of a true quotation, each of which must be rejected:
 * a changed number (or, without digits, a dropped word) and two swapped words.
 */
export function perturbations(quote: string): { kind: string; quote: string }[] {
  const out: { kind: string; quote: string }[] = [];
  const digit = /[0-9٠-٩]+/u.exec(quote);
  if (digit !== null) {
    const western = digit[0].replace(/[٠-٩]/gu, (char) => String(ARABIC_DIGITS.indexOf(char)));
    const changed = String(Number(western) + 7);
    out.push({
      kind: 'number_changed',
      quote: quote.slice(0, digit.index) + changed + quote.slice(digit.index + digit[0].length),
    });
  }
  const words = quote.split(' ');
  if (words.length >= 4) {
    if (digit === null) {
      const dropped = [...words];
      dropped.splice(Math.floor(words.length / 2), 1);
      out.push({ kind: 'word_dropped', quote: dropped.join(' ') });
    }
    const swapped = [...words];
    const i = 1;
    [swapped[i], swapped[i + 1]] = [swapped[i + 1] ?? '', swapped[i] ?? ''];
    out.push({ kind: 'words_swapped', quote: swapped.join(' ') });
  }
  return out.filter((item) => item.quote !== quote);
}

export function ratio(part: number, whole: number): number {
  return whole === 0 ? 0 : part / whole;
}
