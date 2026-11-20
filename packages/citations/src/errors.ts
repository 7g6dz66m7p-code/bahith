/** Stable, machine-readable error codes raised by @bahith/citations. */
export type CitationErrorCode =
  /** Items, clusters or options failed schema validation. */
  | 'CITATION_INVALID_INPUT'
  /** Two items passed together share the same `id`. */
  | 'CITATION_DUPLICATE_ID'
  /** A citation refers to an item id that was not passed in `items`. */
  | 'CITATION_UNKNOWN_ITEM'
  /** `formatNote(s)` was called with a style that does not use footnotes. */
  | 'CITATION_NOT_NOTE_STYLE'
  /** BibTeX/RIS text is empty or whitespace only. */
  | 'CITATION_EMPTY_INPUT'
  /** BibTeX/RIS text exceeds the accepted size. */
  | 'CITATION_INPUT_TOO_LARGE'
  /** BibTeX/RIS text could not be parsed. */
  | 'CITATION_PARSE_FAILED'
  /** BibTeX/RIS text parsed but contained no entries. */
  | 'CITATION_NO_ENTRIES'
  /** The CSL engine failed or returned an unexpected shape. */
  | 'CITATION_ENGINE_FAILED'
  /** Exporting to BibTeX/RIS failed. */
  | 'CITATION_EXPORT_FAILED';

/** One schema problem: where it is and what kind it is. Never the offending value. */
export interface CitationIssue {
  readonly path: readonly (string | number)[];
  readonly code: string;
}

/**
 * Structured, value-free context. Every field is either a schema location, an index or a
 * line/column number: never text taken from the input.
 */
export interface CitationErrorDetails {
  readonly issues?: readonly CitationIssue[];
  /** Index of the offending item/entry in the input list. */
  readonly index?: number;
  /** 1-based line/column reported by the BibTeX parser. */
  readonly line?: number;
  readonly column?: number;
}

const MESSAGES: Record<CitationErrorCode, string> = {
  CITATION_INVALID_INPUT: 'Citation input failed validation.',
  CITATION_DUPLICATE_ID: 'Two citation items share the same id.',
  CITATION_UNKNOWN_ITEM: 'A citation refers to an item that was not provided.',
  CITATION_NOT_NOTE_STYLE: 'The requested style does not use notes.',
  CITATION_EMPTY_INPUT: 'The bibliographic file is empty.',
  CITATION_INPUT_TOO_LARGE: 'The bibliographic file is too large.',
  CITATION_PARSE_FAILED: 'The bibliographic file could not be parsed.',
  CITATION_NO_ENTRIES: 'The bibliographic file contains no entries.',
  CITATION_ENGINE_FAILED: 'The citation engine failed.',
  CITATION_EXPORT_FAILED: 'The bibliography could not be exported.',
};

/**
 * Error raised by @bahith/citations. `code` is stable and safe to show (the web layer maps
 * it to a translated message). `message` is a fixed developer string per code: it never
 * echoes titles, names, file contents or any other input text, and the underlying
 * library error is deliberately not attached as `cause` because its message often quotes
 * the input.
 */
export class CitationError extends Error {
  readonly code: CitationErrorCode;
  readonly details: CitationErrorDetails;

  constructor(code: CitationErrorCode, details: CitationErrorDetails = {}) {
    super(MESSAGES[code]);
    this.name = 'CitationError';
    this.code = code;
    this.details = details;
  }
}
