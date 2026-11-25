/**
 * Reference integrity helpers: pure functions, no network.
 */
import { z } from 'zod';

import { matchKey } from './arabic';
import { LIMITS, parseOrThrow, validateItems, type CslItem, type CslItemInput } from './schema';

const DOI_PATTERN = /^10\.\d{4,9}\/\S+$/;

/** Resolver and scheme prefixes, tried in order (case-insensitive). */
const DOI_PREFIXES: readonly { pattern: RegExp; url: boolean }[] = [
  { pattern: /^https?:\/\/(?:www\.|dx\.)?doi\.org\//i, url: true },
  { pattern: /^doi\.org\//i, url: true },
  { pattern: /^urn:doi:/i, url: false },
  { pattern: /^doi\s*:\s*/i, url: false },
];

/**
 * Normalises a DOI to its canonical lowercase form, e.g.
 * `https://doi.org/10.1038/NATURE14539` → `10.1038/nature14539`.
 *
 * Strips resolver URLs (`https://doi.org/`, `http://dx.doi.org/`), `doi:` and `urn:doi:`
 * prefixes, percent-encoding in URL forms and trailing sentence punctuation (`.,;`).
 * DOIs are case-insensitive by definition, so lowercasing is lossless.
 *
 * @returns the DOI, or `null` when the input does not match `10.NNNN/suffix`.
 */
export function normalizeDoi(raw: string): string | null {
  if (typeof raw !== 'string' || raw.length > 2_048) {
    return null;
  }
  let value = raw.trim();
  const prefix = DOI_PREFIXES.find(({ pattern }) => pattern.test(value));
  if (prefix !== undefined) {
    value = value.replace(prefix.pattern, '');
    if (prefix.url) {
      try {
        value = decodeURIComponent(value);
      } catch {
        return null;
      }
    }
  }
  value = value.replace(/[.,;]+$/, '').toLowerCase();
  return DOI_PATTERN.test(value) ? value : null;
}

// ---------------------------------------------------------------------------
// Duplicate detection
// ---------------------------------------------------------------------------

export type DuplicateReason = 'doi' | 'metadata';

export interface DuplicateGroup {
  /** Ids of the items that look like the same work, in input order. */
  readonly ids: readonly string[];
  /** Why they were grouped: an equal DOI, matching metadata, or both. */
  readonly reasons: readonly DuplicateReason[];
}

export interface DuplicateOptions {
  /** Minimum normalised title similarity in [0, 1] for a metadata match (default 0.9). */
  readonly titleSimilarity?: number;
}

/** Levenshtein similarity in [0, 1] over code points. */
export function similarity(a: string, b: string): number {
  if (a === b) {
    return 1;
  }
  const x = Array.from(a);
  const y = Array.from(b);
  if (x.length === 0 || y.length === 0) {
    return 0;
  }
  let previous = Array.from({ length: y.length + 1 }, (_, j) => j);
  for (let i = 1; i <= x.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= y.length; j += 1) {
      const cost = x[i - 1] === y[j - 1] ? 0 : 1;
      current[j] = Math.min(
        (previous[j] ?? 0) + 1,
        (current[j - 1] ?? 0) + 1,
        (previous[j - 1] ?? 0) + cost,
      );
    }
    previous = current;
  }
  return 1 - (previous[y.length] ?? 0) / Math.max(x.length, y.length);
}

function firstAuthorKey(item: CslItem): string {
  const first = item.author?.[0] ?? item.editor?.[0];
  const family = first?.family ?? first?.literal ?? '';
  // «الجابري» and «جابري» are the same family name; drop the article before comparing.
  return matchKey(family).replace(/^ال/u, '');
}

function yearKey(item: CslItem): string {
  const year = item.issued?.['date-parts']?.[0]?.[0];
  return year === undefined ? (item.issued?.literal ?? item.issued?.raw ?? '') : String(year);
}

class UnionFind {
  private readonly parent: number[];

  constructor(size: number) {
    this.parent = Array.from({ length: size }, (_, i) => i);
  }

  find(i: number): number {
    let root = i;
    while (this.parent[root] !== root) {
      root = this.parent[root] ?? root;
    }
    let node = i;
    while (this.parent[node] !== root) {
      const next = this.parent[node] ?? root;
      this.parent[node] = root;
      node = next;
    }
    return root;
  }

  union(a: number, b: number): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) {
      this.parent[Math.max(ra, rb)] = Math.min(ra, rb);
    }
  }
}

/**
 * Groups items that probably describe the same work.
 *
 * 1. Equal normalised DOI ({@link normalizeDoi}).
 * 2. Otherwise: same year and same normalised first-author family name (Arabic
 *    normalised, «ال» ignored, case and diacritics folded) and title similarity of at
 *    least `titleSimilarity`. Two items with different valid DOIs are never merged by
 *    metadata (a preprint and its journal version stay separate and are left to a human).
 *
 * Groups are transitive, contain at least two ids and are ordered by first appearance.
 */
export function findDuplicateReferences(
  items: readonly CslItemInput[],
  options: DuplicateOptions = {},
): DuplicateGroup[] {
  const threshold = parseOrThrow(z.number().min(0).max(1).default(0.9), options.titleSimilarity, [
    'options',
    'titleSimilarity',
  ]);
  const valid = validateItems(items);
  const sets = new UnionFind(valid.length);
  const reasons = new Map<string, Set<DuplicateReason>>();
  const addReason = (a: number, b: number, reason: DuplicateReason): void => {
    sets.union(a, b);
    const key = `${Math.min(a, b)}:${Math.max(a, b)}`;
    const set = reasons.get(key) ?? new Set<DuplicateReason>();
    set.add(reason);
    reasons.set(key, set);
  };

  const dois = valid.map((item) => (item.DOI === undefined ? null : normalizeDoi(item.DOI)));
  const byDoi = new Map<string, number>();
  dois.forEach((doi, index) => {
    if (doi === null) {
      return;
    }
    const first = byDoi.get(doi);
    if (first === undefined) {
      byDoi.set(doi, index);
    } else {
      addReason(first, index, 'doi');
    }
  });

  // Bucket by (year, first author) so titles are only compared within a bucket.
  const buckets = new Map<string, number[]>();
  valid.forEach((item, index) => {
    const title = matchKey(item.title ?? '');
    if (title === '') {
      return;
    }
    const key = `${yearKey(item)}\u0000${firstAuthorKey(item)}`;
    const bucket = buckets.get(key) ?? [];
    bucket.push(index);
    buckets.set(key, bucket);
  });
  const titles = valid.map((item) => matchKey(item.title ?? ''));
  for (const bucket of buckets.values()) {
    for (let i = 0; i < bucket.length; i += 1) {
      for (let j = i + 1; j < bucket.length; j += 1) {
        const a = bucket[i] ?? 0;
        const b = bucket[j] ?? 0;
        const doiA = dois[a] ?? null;
        const doiB = dois[b] ?? null;
        if (doiA !== null && doiB !== null && doiA !== doiB) {
          continue;
        }
        if (similarity(titles[a] ?? '', titles[b] ?? '') >= threshold) {
          addReason(a, b, 'metadata');
        }
      }
    }
  }

  const groups = new Map<number, number[]>();
  valid.forEach((_, index) => {
    const root = sets.find(index);
    const members = groups.get(root) ?? [];
    members.push(index);
    groups.set(root, members);
  });

  const result: DuplicateGroup[] = [];
  for (const members of [...groups.values()].sort((a, b) => (a[0] ?? 0) - (b[0] ?? 0))) {
    if (members.length < 2) {
      continue;
    }
    const groupReasons = new Set<DuplicateReason>();
    for (let i = 0; i < members.length; i += 1) {
      for (let j = i + 1; j < members.length; j += 1) {
        for (const reason of reasons.get(`${members[i] ?? 0}:${members[j] ?? 0}`) ?? []) {
          groupReasons.add(reason);
        }
      }
    }
    result.push({
      ids: members.map((index) => valid[index]?.id ?? ''),
      reasons: (['doi', 'metadata'] as const).filter((reason) => groupReasons.has(reason)),
    });
  }
  return result;
}

// ---------------------------------------------------------------------------
// Citation ↔ reference consistency
// ---------------------------------------------------------------------------

const idList = z.array(z.string().min(1).max(LIMITS.id)).max(LIMITS.items * 10);

const consistencyInput = z.object({
  citedIds: idList,
  bibliographyIds: idList,
});

export interface CitationConsistency {
  /** Cited in the text but absent from the reference list, in first-citation order. */
  readonly citedWithoutReference: readonly string[];
  /** In the reference list but never cited, in reference-list order. */
  readonly referencedButNotCited: readonly string[];
}

/**
 * Compares the ids cited in a document with the ids in its reference list. Both lists
 * may contain repeats; each id is reported once. Ids are compared exactly.
 */
export function checkCitationConsistency(input: {
  readonly citedIds: readonly string[];
  readonly bibliographyIds: readonly string[];
}): CitationConsistency {
  const { citedIds, bibliographyIds } = parseOrThrow(consistencyInput, input, ['input']);
  const cited = new Set(citedIds);
  const listed = new Set(bibliographyIds);
  return {
    citedWithoutReference: [...cited].filter((id) => !listed.has(id)),
    referencedButNotCited: [...listed].filter((id) => !cited.has(id)),
  };
}
