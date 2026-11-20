import { z } from 'zod';

import { CitationError, type CitationIssue } from './errors';
import { ALL_FORMAT_STYLES, CITATION_LOCALES, OUTPUT_FORMATS } from './styles';

/** Item types of CSL-JSON 1.0.2. */
export const CSL_TYPES = [
  'article',
  'article-journal',
  'article-magazine',
  'article-newspaper',
  'bill',
  'book',
  'broadcast',
  'chapter',
  'classic',
  'collection',
  'dataset',
  'document',
  'entry',
  'entry-dictionary',
  'entry-encyclopedia',
  'event',
  'figure',
  'graphic',
  'hearing',
  'interview',
  'legal_case',
  'legislation',
  'manuscript',
  'map',
  'motion_picture',
  'musical_score',
  'pamphlet',
  'paper-conference',
  'patent',
  'performance',
  'periodical',
  'personal_communication',
  'post',
  'post-weblog',
  'regulation',
  'report',
  'review',
  'review-book',
  'software',
  'song',
  'speech',
  'standard',
  'thesis',
  'treaty',
  'webpage',
] as const;

export type CslType = (typeof CSL_TYPES)[number];

/** Locator labels understood by CSL (`citation-item.label`). */
export const LOCATOR_LABELS = [
  'act',
  'appendix',
  'article-locator',
  'book',
  'canon',
  'chapter',
  'column',
  'elocation',
  'equation',
  'figure',
  'folio',
  'issue',
  'line',
  'note',
  'opus',
  'page',
  'paragraph',
  'part',
  'rule',
  'scene',
  'section',
  'sub-verbo',
  'supplement',
  'table',
  'timestamp',
  'title',
  'verse',
  'volume',
] as const;

export type LocatorLabel = (typeof LOCATOR_LABELS)[number];

/** Upper bounds that keep a single call cheap and refuse pathological input. */
export const LIMITS = {
  items: 10_000,
  text: 2_000,
  longText: 20_000,
  names: 500,
  clusterItems: 100,
  clusters: 10_000,
  locator: 64,
  id: 256,
} as const;

/**
 * Drops `undefined`, `null` and blank strings (recursively) so optional fields can be
 * declared once: absent and empty mean the same thing.
 */
function dropEmpty(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(dropEmpty);
  }
  if (typeof value === 'object' && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [key, field] of Object.entries(value)) {
      const cleaned = dropEmpty(field);
      if (cleaned !== undefined) {
        out[key] = cleaned;
      }
    }
    return out;
  }
  if (value === null || (typeof value === 'string' && value.trim() === '')) {
    return undefined;
  }
  return value;
}

/** No lone surrogates or NUL: such strings cannot be stored or exported safely. */
const isWellFormed = (value: string): boolean =>
  !/\p{Surrogate}/u.test(value) && !value.includes(String.fromCharCode(0));

const text = (max: number = LIMITS.text) => z.string().trim().min(1).max(max).refine(isWellFormed);

/** CSL "number-like" fields accept numbers or strings; they are kept as strings. */
const numeric = z
  .union([z.string(), z.number().int().nonnegative()])
  .transform((value) => String(value).trim())
  .pipe(text(LIMITS.locator * 4));

const datePart = z.union([
  z.number().int(),
  z
    .string()
    .trim()
    .regex(/^-?\d{1,6}$/)
    .transform(Number),
]);

const dateParts = z.union([
  z.tuple([datePart]),
  z.tuple([datePart, datePart]),
  z.tuple([datePart, datePart, datePart]),
]);

export const cslDateSchema = z
  .object({
    'date-parts': z.union([z.tuple([dateParts]), z.tuple([dateParts, dateParts])]).optional(),
    literal: text().optional(),
    raw: text().optional(),
    season: z.union([text(), z.number().int()]).optional(),
    circa: z.union([z.boolean(), text(), z.number().int()]).optional(),
  })
  .refine(
    (date) =>
      date['date-parts'] !== undefined || date.literal !== undefined || date.raw !== undefined,
    {
      message: 'date-needs-parts-literal-or-raw',
    },
  );

export const cslNameSchema = z
  .object({
    family: text().optional(),
    given: text().optional(),
    literal: text().optional(),
    suffix: text().optional(),
    'dropping-particle': text().optional(),
    'non-dropping-particle': text().optional(),
  })
  .refine((name) => name.family !== undefined || name.literal !== undefined, {
    message: 'name-needs-family-or-literal',
  });

const names = z.array(cslNameSchema).min(1).max(LIMITS.names);

const itemId = z
  .union([z.string(), z.number().int()])
  .transform((value) => String(value).trim())
  .pipe(text(LIMITS.id));

/**
 * The CSL-JSON subset this package accepts and produces. Unknown fields are dropped
 * (they never reach the engine); every string is trimmed and bounded.
 */
export const cslItemSchema = z.preprocess(
  dropEmpty,
  z.object({
    id: itemId,
    type: z.enum(CSL_TYPES),
    'citation-key': text(LIMITS.id).optional(),
    language: text(35).optional(),
    title: text().optional(),
    'title-short': text().optional(),
    'container-title': text().optional(),
    'container-title-short': text().optional(),
    'collection-title': text().optional(),
    'collection-number': numeric.optional(),
    author: names.optional(),
    editor: names.optional(),
    translator: names.optional(),
    'container-author': names.optional(),
    'collection-editor': names.optional(),
    issued: cslDateSchema.optional(),
    accessed: cslDateSchema.optional(),
    'original-date': cslDateSchema.optional(),
    volume: numeric.optional(),
    issue: numeric.optional(),
    page: numeric.optional(),
    'number-of-pages': numeric.optional(),
    'number-of-volumes': numeric.optional(),
    edition: numeric.optional(),
    number: numeric.optional(),
    publisher: text().optional(),
    'publisher-place': text().optional(),
    genre: text().optional(),
    DOI: text().optional(),
    URL: text().optional(),
    ISBN: text().optional(),
    ISSN: text().optional(),
    note: text(LIMITS.longText).optional(),
    abstract: text(LIMITS.longText).optional(),
  }),
);

export type CslName = z.output<typeof cslNameSchema>;
export type CslDate = z.output<typeof cslDateSchema>;
/** A validated CSL-JSON item. */
export type CslItem = z.output<typeof cslItemSchema>;
/**
 * What callers may pass: any object; it is validated into a {@link CslItem} (numbers
 * become strings, blank fields and unknown fields are dropped).
 */
export type CslItemInput = Readonly<Record<string, unknown>>;

export const itemsSchema = z.array(cslItemSchema).max(LIMITS.items);

export const formatOptionsSchema = z.object({
  style: z.enum(ALL_FORMAT_STYLES),
  locale: z.enum(CITATION_LOCALES),
  format: z.enum(OUTPUT_FORMATS).default('text'),
});

export type FormatOptions = z.input<typeof formatOptionsSchema>;
export type ResolvedFormatOptions = z.output<typeof formatOptionsSchema>;

export const locatorSchema = z.object({
  id: itemId,
  locator: z
    .union([z.string(), z.number().int().nonnegative()])
    .transform((value) => String(value).trim())
    .pipe(text(LIMITS.locator)),
  label: z.enum(LOCATOR_LABELS).default('page'),
});

export const clusterSchema = z.object({
  itemIds: z.array(itemId).min(1).max(LIMITS.clusterItems),
  locators: z.array(locatorSchema).max(LIMITS.clusterItems).optional(),
});

/** One in-text citation or footnote: the cited items and optional pinpoint locators. */
export type CitationCluster = z.input<typeof clusterSchema>;
export type ResolvedCluster = z.output<typeof clusterSchema>;

/** Converts Zod issues to value-free {@link CitationIssue}s. */
export function toIssues(
  error: z.ZodError,
  prefix: readonly (string | number)[] = [],
): CitationIssue[] {
  return error.issues.map((issue) => ({
    path: [...prefix, ...issue.path.map((part) => (typeof part === 'symbol' ? '?' : part))],
    code: issue.code,
  }));
}

export function parseOrThrow<T extends z.ZodType>(
  schema: T,
  input: unknown,
  prefix: readonly (string | number)[] = [],
): z.output<T> {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new CitationError('CITATION_INVALID_INPUT', { issues: toIssues(result.error, prefix) });
  }
  return result.data;
}

/** Validates items and rejects duplicate ids (the engine keys everything by id). */
export function validateItems(input: readonly unknown[]): CslItem[] {
  const items = parseOrThrow(itemsSchema, input, ['items']);
  const seen = new Set<string>();
  items.forEach((item, index) => {
    if (seen.has(item.id)) {
      throw new CitationError('CITATION_DUPLICATE_ID', { index });
    }
    seen.add(item.id);
  });
  return items;
}
