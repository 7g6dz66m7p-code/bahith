/**
 * Shared types, dataset validation and the seeded PRNG for the fabricated-reference
 * evaluation (eval/references). No network access happens here.
 *
 * The scholarly package is imported by relative path (../../packages/scholarly/src) rather
 * than as `@bahith/scholarly`: the eval package declares no dependencies yet, and the build
 * script needs two internals (`crossrefWorkSchema`, `normalizeCrossrefWork`) that the package
 * entry point does not export.
 */
import { resolve } from 'node:path';

import type { VerificationStatus } from '../../packages/scholarly/src/index';

export const HERE = import.meta.dirname;
export const DATASET_PATH = resolve(HERE, 'dataset.json');
export const SAMPLE_PATH = resolve(HERE, 'crossref-sample.json');
export const RESULTS_DIR = resolve(HERE, 'results');

export const KINDS = ['real', 'fabricated', 'mismatched'] as const;
export type Kind = (typeof KINDS)[number];

export const EXPECTED = ['verified', 'not_found', 'mismatch'] as const;
export type Expected = (typeof EXPECTED)[number];

export interface DatasetAuthor {
  family: string;
  given?: string;
}

export interface DatasetInput {
  doi?: string;
  title: string;
  authors: DatasetAuthor[];
  year?: number;
  container?: string;
}

export interface DatasetItem {
  id: string;
  kind: Kind;
  input: DatasetInput;
  /** The single most specific correct answer. */
  expected: Expected;
  /**
   * Every status that counts as a pass for this item. `unverifiable` is never accepted:
   * a provider failure is not evidence either way.
   */
  accepted: Expected[];
  /** How the item was produced (sampling query, borrowed prefix, build-time checks). */
  source: string;
}

export interface Dataset {
  schemaVersion: 1;
  name: string;
  generatedAt: string;
  generator: string;
  seed: number;
  note: string;
  crossref: { endpoint: string; sampledAt: string; requests: string[] };
  expectations: Record<Kind, string>;
  buildChecks: Record<string, number>;
  counts: Record<Kind, number>;
  items: DatasetItem[];
}

/** A work as normalised from a Crossref sample (the CSL view `verifyReference` also sees). */
export interface PoolWork {
  doi: string;
  title: string;
  authors: DatasetAuthor[];
  year: number;
  container: string;
  /** True when the title contains Arabic script. */
  arabic: boolean;
}

export interface SampleSnapshot {
  sampledAt: string;
  requests: string[];
  general: PoolWork[];
  arabic: PoolWork[];
}

// ---------------------------------------------------------------------------------------
// Deterministic PRNG (mulberry32): same seed, same sequence, on every platform.

export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function pick<T>(random: () => number, list: readonly T[]): T {
  const value = list[Math.floor(random() * list.length)];
  if (value === undefined) throw new Error('pick() from an empty list');
  return value;
}

export function int(random: () => number, min: number, max: number): number {
  return min + Math.floor(random() * (max - min + 1));
}

/** Fisher–Yates shuffle into a new array. */
export function shuffle<T>(random: () => number, list: readonly T[]): T[] {
  const out = [...list];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    const a = out[i] as T;
    out[i] = out[j] as T;
    out[j] = a;
  }
  return out;
}

// ---------------------------------------------------------------------------------------
// Dataset validation (hand-written: the eval package has no dependency on zod).

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function fail(path: string, message: string): never {
  throw new Error(`dataset.json: ${path} ${message}`);
}

function str(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.trim() === '') fail(path, 'must be a non-empty string');
  return value;
}

function optStr(value: unknown, path: string): string | undefined {
  return value === undefined ? undefined : str(value, path);
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], path: string): T {
  const found = allowed.find((option) => option === value);
  if (found === undefined) fail(path, `must be one of ${allowed.join(', ')}`);
  return found;
}

function parseInput(value: unknown, path: string): DatasetInput {
  if (!isObject(value)) fail(path, 'must be an object');
  const authorsRaw = value.authors;
  if (!Array.isArray(authorsRaw) || authorsRaw.length === 0) {
    fail(`${path}.authors`, 'must be a non-empty array');
  }
  const authors = authorsRaw.map((author: unknown, i): DatasetAuthor => {
    if (!isObject(author)) fail(`${path}.authors[${i}]`, 'must be an object');
    const family = str(author.family, `${path}.authors[${i}].family`);
    const given = optStr(author.given, `${path}.authors[${i}].given`);
    return given === undefined ? { family } : { family, given };
  });
  const input: DatasetInput = { title: str(value.title, `${path}.title`), authors };
  const doi = optStr(value.doi, `${path}.doi`);
  if (doi !== undefined) input.doi = doi;
  if (value.year !== undefined) {
    if (typeof value.year !== 'number' || !Number.isInteger(value.year)) {
      fail(`${path}.year`, 'must be an integer');
    }
    input.year = value.year;
  }
  const container = optStr(value.container, `${path}.container`);
  if (container !== undefined) input.container = container;
  return input;
}

export function parseDataset(json: unknown): Dataset {
  if (!isObject(json)) fail('$', 'must be an object');
  if (json.schemaVersion !== 1) fail('schemaVersion', 'must be 1');
  if (!Array.isArray(json.items)) fail('items', 'must be an array');
  const ids = new Set<string>();
  const items = json.items.map((raw: unknown, i): DatasetItem => {
    const path = `items[${i}]`;
    if (!isObject(raw)) fail(path, 'must be an object');
    const id = str(raw.id, `${path}.id`);
    if (ids.has(id)) fail(`${path}.id`, 'is duplicated');
    ids.add(id);
    if (!Array.isArray(raw.accepted) || raw.accepted.length === 0) {
      fail(`${path}.accepted`, 'must be a non-empty array');
    }
    const expected = oneOf(raw.expected, EXPECTED, `${path}.expected`);
    const accepted = raw.accepted.map((value: unknown, j) =>
      oneOf(value, EXPECTED, `${path}.accepted[${j}]`),
    );
    if (!accepted.includes(expected)) fail(`${path}.accepted`, 'must include expected');
    return {
      id,
      kind: oneOf(raw.kind, KINDS, `${path}.kind`),
      input: parseInput(raw.input, `${path}.input`),
      expected,
      accepted,
      source: str(raw.source, `${path}.source`),
    };
  });
  const counts = { real: 0, fabricated: 0, mismatched: 0 };
  for (const item of items) counts[item.kind] += 1;
  if (!isObject(json.crossref)) fail('crossref', 'must be an object');
  return {
    schemaVersion: 1,
    name: str(json.name, 'name'),
    generatedAt: str(json.generatedAt, 'generatedAt'),
    generator: str(json.generator, 'generator'),
    seed: typeof json.seed === 'number' ? json.seed : fail('seed', 'must be a number'),
    note: str(json.note, 'note'),
    crossref: {
      endpoint: str(json.crossref.endpoint, 'crossref.endpoint'),
      sampledAt: str(json.crossref.sampledAt, 'crossref.sampledAt'),
      requests: Array.isArray(json.crossref.requests)
        ? json.crossref.requests.map((r: unknown, i) => str(r, `crossref.requests[${i}]`))
        : fail('crossref.requests', 'must be an array'),
    },
    expectations: {
      real: str(isObject(json.expectations) ? json.expectations.real : undefined, 'expectations'),
      fabricated: str(
        isObject(json.expectations) ? json.expectations.fabricated : undefined,
        'expectations',
      ),
      mismatched: str(
        isObject(json.expectations) ? json.expectations.mismatched : undefined,
        'expectations',
      ),
    },
    buildChecks: isObject(json.buildChecks)
      ? Object.fromEntries(
          Object.entries(json.buildChecks).map(([key, value]) => [
            key,
            typeof value === 'number' ? value : fail(`buildChecks.${key}`, 'must be a number'),
          ]),
        )
      : fail('buildChecks', 'must be an object'),
    counts,
    items,
  };
}

/** Outcome recorded per item by run.ts; `error` = verifyReference threw unexpectedly. */
export type RunStatus = VerificationStatus | 'error';

export function writeLine(stream: NodeJS.WriteStream, line = ''): void {
  stream.write(`${line}\n`);
}
