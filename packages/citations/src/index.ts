/**
 * Citation formatting (Phase 4): citeproc-js + CSL styles, deterministic code only.
 * A language model never writes a reference; references are built from verified
 * `sources` rows.
 *
 * Phase 1 only fixes the list of supported styles, shared with the database enum.
 */
export const CITATION_STYLES = ['apa-7', 'chicago', 'mla'] as const;

export type CitationStyle = (typeof CITATION_STYLES)[number];

export function isCitationStyle(value: string): value is CitationStyle {
  return (CITATION_STYLES as readonly string[]).includes(value);
}
