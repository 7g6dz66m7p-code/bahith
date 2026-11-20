/**
 * @bahith/citations — deterministic citation engine.
 *
 * A language model never writes a reference: references and citations are built by
 * code from verified `sources` rows, using the bundled CSL styles (APA 7, Chicago 18
 * author-date and notes-bibliography, MLA 9) run by citeproc-js, plus the in-house
 * «التوثيق التقليدي» formatter. Decisions: docs/adr/0008-citation-engine.md.
 */
export {
  ALL_FORMAT_STYLES,
  CITATION_LOCALES,
  CITATION_STYLES,
  isCitationStyle,
  isFormatStyle,
  isNoteStyle,
  NOTE_STYLES,
  OUTPUT_FORMATS,
  type CitationLocale,
  type CitationStyle,
  type FormatStyle,
  type NoteStyle,
  type OutputFormat,
} from './styles';

export {
  CitationError,
  type CitationErrorCode,
  type CitationErrorDetails,
  type CitationIssue,
} from './errors';

export {
  CSL_TYPES,
  cslItemSchema,
  LIMITS,
  LOCATOR_LABELS,
  type CitationCluster,
  type CslDate,
  type CslItem,
  type CslItemInput,
  type CslName,
  type CslType,
  type FormatOptions,
  type LocatorLabel,
} from './schema';

export {
  formatBibliography,
  formatCitation,
  formatNote,
  formatNotes,
  type BibliographyEntry,
  type FormattedBibliography,
} from './format';

export { ARABIC_TRADITIONAL_VERSION } from './arabic-traditional';

export { MAX_INTERCHANGE_CHARS, parseBibtex, parseRis, toBibtex, toRis } from './interchange';

export {
  checkCitationConsistency,
  findDuplicateReferences,
  normalizeDoi,
  similarity,
  type CitationConsistency,
  type DuplicateGroup,
  type DuplicateOptions,
  type DuplicateReason,
} from './integrity';

export { hasArabicScript, matchKey, normalizeArabic } from './arabic';
