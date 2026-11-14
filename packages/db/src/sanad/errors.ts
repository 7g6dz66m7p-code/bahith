/** Stable errors contain no queries, source text, or provider credentials. */
export type SanadErrorCode =
  | 'SANAD_INVALID_INPUT'
  | 'SANAD_FORBIDDEN'
  | 'SANAD_PROJECT_NOT_FOUND'
  | 'SANAD_VERSION_CONFLICT'
  | 'SANAD_FILE_NOT_FOUND'
  | 'SANAD_SOURCE_MISMATCH';

export class SanadError extends Error {
  readonly code: SanadErrorCode;

  constructor(code: SanadErrorCode, message: string = code) {
    super(message);
    this.name = 'SanadError';
    this.code = code;
  }
}
