/** Stable errors contain no queries, source text, or provider credentials. */
export type SanadErrorCode =
  | 'SANAD_INVALID_INPUT'
  | 'SANAD_FORBIDDEN'
  | 'SANAD_PROJECT_NOT_FOUND'
  | 'SANAD_VERSION_CONFLICT'
  | 'SANAD_FILE_NOT_FOUND'
  | 'SANAD_SOURCE_MISMATCH'
  /** The anchored text is not (or no longer unambiguously) in the draft. */
  | 'REVIEW_ANCHOR_STALE'
  /** The anchor does not match the stored version it names. */
  | 'REVIEW_ANCHOR_INVALID'
  | 'REVIEW_NOT_FOUND'
  /** The comment is not open, or the action does not apply to its kind. */
  | 'REVIEW_INVALID_STATE';

export class SanadError extends Error {
  readonly code: SanadErrorCode;

  constructor(code: SanadErrorCode, message: string = code) {
    super(message);
    this.name = 'SanadError';
    this.code = code;
  }
}
