import { z } from 'zod';

import { SanadError } from './errors';

const position = z.number().int().nonnegative();
const page = z.number().int().positive().nullable();
const direction = z.enum(['rtl', 'ltr', 'auto']);
const text = z
  .string()
  .max(40_000_000)
  .refine((value) => !value.includes('\u0000') && !/\p{Surrogate}/u.test(value));

/** MIME types the extractor understands; images are OCR'd page by page. */
export const EXTRACTABLE_MIME_TYPES = [
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'text/plain',
  'image/png',
  'image/jpeg',
  'image/tiff',
] as const;

export type ExtractableMimeType = (typeof EXTRACTABLE_MIME_TYPES)[number];

/** Formats whose units are physical pages (so every unit carries a page number). */
export function isPagedMimeType(mimeType: string): boolean {
  return mimeType === 'application/pdf' || mimeType.startsWith('image/');
}

/** Shared with the Python extractor. Offsets count Unicode code points, not UTF-16. */
export const extractionManifestSchema = z.strictObject({
  schemaVersion: z.literal(1),
  fileSha256: z.string().regex(/^[a-f0-9]{64}$/),
  mimeType: z.enum(EXTRACTABLE_MIME_TYPES),
  extractorVersion: z.string().min(1).max(200),
  chunkerVersion: z.string().min(1).max(200),
  units: z
    .array(
      z.strictObject({
        index: position,
        page,
        kind: z.enum(['page', 'paragraph', 'table_cell', 'text']),
        content: text,
        direction,
        // Optional for manifests written before OCR existed (they are all "text").
        method: z.enum(['text', 'ocr']).optional(),
        ocrConfidence: z.number().min(0).max(100).nullable().optional(),
      }),
    )
    .max(20_000),
  failures: z
    .array(
      z.strictObject({
        unitIndex: position,
        page,
        code: z.string().regex(/^[A-Z][A-Z0-9_]{0,79}$/),
      }),
    )
    .max(20_000),
  chunks: z
    .array(
      z.strictObject({
        index: position,
        unitIndex: position,
        charStart: position,
        charEnd: position,
        content: text.refine((value) => value.trim().length > 0),
        pageStart: page,
        pageEnd: page,
        tokenCount: z.number().int().positive().max(800),
        direction,
      }),
    )
    .max(50_000),
});

export type ExtractionManifest = z.infer<typeof extractionManifestSchema>;

/** Input is well-formed Unicode: low surrogates are the second half of one code point. */
function codePointLength(value: string): number {
  let count = 0;
  for (let offset = 0; offset < value.length; offset += 1) {
    const code = value.charCodeAt(offset);
    if (code < 0xdc00 || code > 0xdfff) count += 1;
  }
  return count;
}

/** Reject corruption before it can become a retrievable/citable passage. */
export function parseExtractionManifest(input: unknown): ExtractionManifest {
  const parsed = extractionManifestSchema.safeParse(input);
  if (!parsed.success) throw new SanadError('SANAD_INVALID_INPUT');
  const manifest = parsed.data;
  const invalid = (): never => {
    throw new SanadError('SANAD_INVALID_INPUT');
  };
  const unitMap = new Map(manifest.units.map((unit) => [unit.index, unit]));
  if (unitMap.size !== manifest.units.length) invalid();
  if (manifest.units.reduce((sum, unit) => sum + codePointLength(unit.content), 0) > 20_000_000)
    invalid();
  const failed = new Set(manifest.failures.map((failure) => failure.unitIndex));
  const paged = isPagedMimeType(manifest.mimeType);
  for (const unit of manifest.units) {
    if (failed.has(unit.index) && unit.content.length > 0) invalid();
    // OCR text only exists for page images, and always comes with its method label.
    if (unit.method === 'ocr' && (!paged || unit.kind !== 'page')) invalid();
    if (unit.method !== 'ocr' && unit.ocrConfidence != null) invalid();
    if (manifest.mimeType.startsWith('image/') && unit.content.length > 0 && unit.method !== 'ocr')
      invalid();
    if (paged) {
      if (unit.kind !== 'page' || unit.page === null) invalid();
    } else if (unit.page !== null || unit.kind === 'page') invalid();
  }
  for (const failure of manifest.failures) {
    if (!paged && failure.page !== null) invalid();
    const unit = unitMap.get(failure.unitIndex);
    if (unit !== undefined && unit.page !== failure.page) invalid();
  }
  const codePoints = new Map<number, string[]>();
  for (const [index, chunk] of manifest.chunks.entries()) {
    const unit = unitMap.get(chunk.unitIndex);
    if (chunk.index !== index || unit === undefined || failed.has(chunk.unitIndex)) invalid();
    if (unit === undefined) return invalid();
    const points = codePoints.get(unit.index) ?? Array.from(unit.content);
    codePoints.set(unit.index, points);
    if (
      chunk.charEnd <= chunk.charStart ||
      chunk.charEnd > points.length ||
      points.slice(chunk.charStart, chunk.charEnd).join('') !== chunk.content ||
      chunk.pageStart !== unit.page ||
      chunk.pageEnd !== unit.page
    )
      invalid();
  }
  return manifest;
}
