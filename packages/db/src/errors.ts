/** Stable, machine-readable error codes raised by the database layer. */
export type DbErrorCode =
  | 'DB_INVALID_CONTEXT'
  | 'DB_MIGRATION_CHECKSUM_MISMATCH'
  | 'DB_MIGRATION_MISSING_DOWN'
  | 'DB_MIGRATION_UNKNOWN'
  | 'DB_CONFIG_INVALID'
  | 'DB_REMOTE_TARGET_REFUSED';

/**
 * Error raised by @bahith/db. `code` is stable and safe to expose; `message` is for
 * developers and never contains row data or research content.
 */
export class DbError extends Error {
  readonly code: DbErrorCode;

  constructor(code: DbErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'DbError';
    this.code = code;
  }
}
