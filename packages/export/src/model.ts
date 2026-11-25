import { z } from 'zod';

import { ExportError, type ExportIssue } from './errors';

/**
 * The structured document model every exporter consumes.
 *
 * Academic-integrity rules enforced by shape, not by convention:
 * - citations carry display text that the citation engine already formatted;
 * - bibliography entries are pre-formatted strings;
 * this package copies both verbatim and never invents, reorders or reformats a reference.
 *
 * Zod issue messages are stable detail codes (e.g. `EMPTY_TITLE`), surfaced through
 * `ExportError.issues` so callers can map them to translated messages.
 */

const MAX_TEXT = 1_000_000;

const text = (code = 'INVALID_TEXT') => z.string({ error: code }).max(MAX_TEXT, { error: code });
const nonEmpty = (code: string) =>
  z
    .string({ error: code })
    .max(MAX_TEXT, { error: code })
    .refine((value) => value.trim().length > 0, { error: code });

export const directionSchema = z.enum(['rtl', 'ltr'], { error: 'INVALID_DIRECTION' });
export type Direction = z.infer<typeof directionSchema>;

export const languageSchema = z.enum(['ar', 'en'], { error: 'INVALID_LANGUAGE' });
export type Language = z.infer<typeof languageSchema>;

export const textRunSchema = z.strictObject({
  type: z.literal('text'),
  text: text(),
  bold: z.boolean().optional(),
  italic: z.boolean().optional(),
});
export type TextRun = z.infer<typeof textRunSchema>;

export const citationRunSchema = z.strictObject({
  type: z.literal('citation'),
  /** Display text exactly as the citation engine formatted it, locator included. */
  text: nonEmpty('EMPTY_CITATION'),
  sourceId: nonEmpty('MISSING_SOURCE_ID'),
  /** Metadata only (e.g. "ص. 15"); never appended to `text`, which is already final. */
  locator: text().optional(),
});
export type CitationRun = z.infer<typeof citationRunSchema>;

/** Footnote content: text and citations; footnotes do not nest. */
export const noteRunSchema = z.discriminatedUnion('type', [textRunSchema, citationRunSchema], {
  error: 'INVALID_RUN',
});
export type NoteRun = z.infer<typeof noteRunSchema>;

export const footnoteRunSchema = z.strictObject({
  type: z.literal('footnote'),
  content: z.array(noteRunSchema).min(1, { error: 'EMPTY_FOOTNOTE' }),
});
export type FootnoteRun = z.infer<typeof footnoteRunSchema>;

export const inlineSchema = z.discriminatedUnion(
  'type',
  [textRunSchema, citationRunSchema, footnoteRunSchema],
  { error: 'INVALID_RUN' },
);
export type Inline = z.infer<typeof inlineSchema>;

const runs = z.array(inlineSchema);

export const headingBlockSchema = z.strictObject({
  type: z.literal('heading'),
  /** 1 = chapter (فصل), 2 = section (مبحث), 3 = subsection (مطلب), 4 = sub-subsection. */
  level: z
    .number({ error: 'INVALID_HEADING_LEVEL' })
    .int({ error: 'INVALID_HEADING_LEVEL' })
    .min(1, { error: 'INVALID_HEADING_LEVEL' })
    .max(4, { error: 'INVALID_HEADING_LEVEL' }),
  text: nonEmpty('EMPTY_HEADING'),
  dir: directionSchema.optional(),
});
export type HeadingBlock = z.infer<typeof headingBlockSchema>;

export const paragraphBlockSchema = z.strictObject({
  type: z.literal('paragraph'),
  runs,
  dir: directionSchema.optional(),
});
export type ParagraphBlock = z.infer<typeof paragraphBlockSchema>;

export const blockquoteBlockSchema = z.strictObject({
  type: z.literal('blockquote'),
  runs,
  dir: directionSchema.optional(),
});
export type BlockquoteBlock = z.infer<typeof blockquoteBlockSchema>;

export const listBlockSchema = z.strictObject({
  type: z.literal('list'),
  ordered: z.boolean(),
  items: z.array(runs).min(1, { error: 'EMPTY_LIST' }),
  dir: directionSchema.optional(),
});
export type ListBlock = z.infer<typeof listBlockSchema>;

export const tableBlockSchema = z
  .strictObject({
    type: z.literal('table'),
    header: z.array(text()).min(1, { error: 'EMPTY_TABLE_HEADER' }),
    rows: z.array(z.array(text())),
    caption: text().optional(),
    dir: directionSchema.optional(),
  })
  .refine((table) => table.rows.every((row) => row.length === table.header.length), {
    error: 'TABLE_ROW_WIDTH_MISMATCH',
    path: ['rows'],
  });
export type TableBlock = z.infer<typeof tableBlockSchema>;

export const imageBlockSchema = z.strictObject({
  type: z.literal('image'),
  data: z
    .instanceof(Uint8Array, { error: 'INVALID_IMAGE_DATA' })
    .refine((bytes) => bytes.byteLength > 0, { error: 'INVALID_IMAGE_DATA' }),
  mime: z.string().regex(/^image\/[a-z0-9.+-]+$/u, { error: 'INVALID_IMAGE_MIME' }),
  alt: nonEmpty('MISSING_IMAGE_ALT'),
  caption: text().optional(),
  /** Optional intrinsic size in CSS pixels; sniffed from PNG/JPEG/GIF headers when absent. */
  widthPx: z.number().int().positive().max(20_000).optional(),
  heightPx: z.number().int().positive().max(20_000).optional(),
  dir: directionSchema.optional(),
});
export type ImageBlock = z.infer<typeof imageBlockSchema>;

export const equationBlockSchema = z.strictObject({
  type: z.literal('equation'),
  latex: nonEmpty('EMPTY_EQUATION'),
  /** Plain-text rendering used when the LaTeX cannot be converted for a format. */
  fallbackText: text().optional(),
});
export type EquationBlock = z.infer<typeof equationBlockSchema>;

export const blockSchema = z.discriminatedUnion(
  'type',
  [
    headingBlockSchema,
    paragraphBlockSchema,
    blockquoteBlockSchema,
    listBlockSchema,
    tableBlockSchema,
    imageBlockSchema,
    equationBlockSchema,
  ],
  { error: 'INVALID_BLOCK' },
);
export type Block = z.infer<typeof blockSchema>;

const mm = z.number({ error: 'INVALID_MARGIN' }).min(0, { error: 'INVALID_MARGIN' }).max(100, {
  error: 'INVALID_MARGIN',
});

export const templateSchema = z.strictObject({
  id: nonEmpty('MISSING_TEMPLATE_ID'),
  pageSize: z.enum(['A4', 'Letter'], { error: 'INVALID_PAGE_SIZE' }),
  /** Millimetres; `start`/`end` follow the document direction. */
  margins: z.strictObject({ top: mm, bottom: mm, start: mm, end: mm }),
  fontFamily: nonEmpty('MISSING_FONT_FAMILY').refine((value) => /^[\p{L}\p{N} _-]+$/u.test(value), {
    error: 'INVALID_FONT_FAMILY',
  }),
  fontSizePt: z.number().min(6, { error: 'INVALID_FONT_SIZE' }).max(72, {
    error: 'INVALID_FONT_SIZE',
  }),
  /** Line-height multiplier, e.g. 1.5. */
  lineSpacing: z.number().min(0.8, { error: 'INVALID_LINE_SPACING' }).max(4, {
    error: 'INVALID_LINE_SPACING',
  }),
  coverPage: z.boolean(),
  tableOfContents: z.boolean(),
  pageNumbers: z.boolean(),
});
export type ExportTemplate = z.infer<typeof templateSchema>;

export const metaSchema = z.strictObject({
  title: nonEmpty('EMPTY_TITLE'),
  subtitle: text().optional(),
  author: nonEmpty('EMPTY_AUTHOR'),
  supervisor: text().optional(),
  institution: text().optional(),
  department: text().optional(),
  degree: text().optional(),
  /** Display date as the author wants it printed (e.g. "1446هـ / 2025م"). */
  date: text().optional(),
  language: languageSchema,
  direction: directionSchema,
});
export type ExportMeta = z.infer<typeof metaSchema>;

export const bibliographySchema = z.strictObject({
  heading: nonEmpty('EMPTY_BIBLIOGRAPHY_HEADING'),
  /** Pre-formatted references, copied verbatim. */
  entries: z.array(nonEmpty('EMPTY_BIBLIOGRAPHY_ENTRY')),
});
export type Bibliography = z.infer<typeof bibliographySchema>;

export const exportDocumentSchema = z.strictObject({
  meta: metaSchema,
  template: templateSchema,
  body: z.array(blockSchema),
  bibliography: bibliographySchema,
});
export type ExportDocument = z.infer<typeof exportDocumentSchema>;

/**
 * Validates untrusted input and returns a typed document, or throws
 * `ExportError('EXPORT_INVALID_DOCUMENT')` whose `issues` carry stable detail codes.
 * Issue entries never include field values (document text must not reach logs).
 */
export function parseExportDocument(input: unknown): ExportDocument {
  const result = exportDocumentSchema.safeParse(input);
  if (result.success) return result.data;
  const issues: ExportIssue[] = result.error.issues.map((issue) => ({
    path: issue.path.map(String).join('.'),
    code: /^[A-Z][A-Z_]+$/u.test(issue.message) ? issue.message : 'INVALID_FIELD',
  }));
  throw new ExportError('EXPORT_INVALID_DOCUMENT', { issues });
}
