/**
 * Style identifiers. This module has no runtime dependencies so client code can import
 * it (`@bahith/citations/styles`) without pulling in the citation engine.
 */

/**
 * Styles a project can store (`projects.citation_style`). Kept equal to the database
 * enum `citation_style`; a test enforces it. Changing this list needs a migration.
 *
 * - `apa-7`   — APA 7th edition (CSL `apa.csl`).
 * - `chicago` — Chicago Manual of Style 18th edition, author-date
 *               (CSL `chicago-author-date.csl`).
 * - `mla`     — MLA Handbook 9th edition (CSL `modern-language-association.csl`).
 */
export const CITATION_STYLES = ['apa-7', 'chicago', 'mla'] as const;

export type CitationStyle = (typeof CITATION_STYLES)[number];

export function isCitationStyle(value: string): value is CitationStyle {
  return (CITATION_STYLES as readonly string[]).includes(value);
}

/**
 * Every style the formatter can render. A superset of {@link CITATION_STYLES}; the two
 * extra styles are not (yet) storable on a project.
 *
 * - `chicago-notes`      — Chicago 18th edition, notes and bibliography
 *                          (CSL `chicago-notes-bibliography.csl`).
 * - `arabic-traditional` — «التوثيق التقليدي»: an in-house footnote convention
 *                          implemented in TypeScript (no official CSL style exists);
 *                          see `src/arabic-traditional.ts`.
 */
export const ALL_FORMAT_STYLES = [
  ...CITATION_STYLES,
  'chicago-notes',
  'arabic-traditional',
] as const;

export type FormatStyle = (typeof ALL_FORMAT_STYLES)[number];

export function isFormatStyle(value: string): value is FormatStyle {
  return (ALL_FORMAT_STYLES as readonly string[]).includes(value);
}

/** Styles whose in-text form is a footnote; only these are accepted by `formatNote(s)`. */
export const NOTE_STYLES = [
  'chicago-notes',
  'arabic-traditional',
] as const satisfies readonly FormatStyle[];

export type NoteStyle = (typeof NOTE_STYLES)[number];

export function isNoteStyle(value: string): value is NoteStyle {
  return (NOTE_STYLES as readonly string[]).includes(value);
}

/** Interface languages a citation can be rendered in (CSL locales `ar` and `en-US`). */
export const CITATION_LOCALES = ['ar', 'en'] as const;

export type CitationLocale = (typeof CITATION_LOCALES)[number];

export const OUTPUT_FORMATS = ['text', 'html'] as const;

export type OutputFormat = (typeof OUTPUT_FORMATS)[number];
