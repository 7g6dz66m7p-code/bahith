import type { ProviderId } from './types';

/** Stable error codes. Callers branch on these, never on message text. */
export const SCHOLARLY_ERROR_CODES = [
  'SCHOLARLY_NOT_FOUND',
  'SCHOLARLY_RATE_LIMITED',
  'SCHOLARLY_UPSTREAM_ERROR',
  'SCHOLARLY_TIMEOUT',
  'SCHOLARLY_INVALID_INPUT',
  'SCHOLARLY_CONFIG_MISSING',
  'SCHOLARLY_PARSE_ERROR',
] as const;

export type ScholarlyErrorCode = (typeof SCHOLARLY_ERROR_CODES)[number];

export interface ScholarlyErrorDetails {
  provider?: ProviderId;
  /** HTTP status of the last upstream response, when there was one. */
  status?: number;
  /** Delay the upstream asked for (Retry-After), in milliseconds. */
  retryAfterMs?: number;
  /** Names of missing configuration variables (never their values). */
  variables?: string[];
  /** Zod issue paths for PARSE_ERROR (never the offending values). */
  issuePaths?: string[];
  cause?: unknown;
}

const MESSAGES: Record<ScholarlyErrorCode, string> = {
  SCHOLARLY_NOT_FOUND: 'The scholarly service has no record for the requested identifier.',
  SCHOLARLY_RATE_LIMITED: 'The scholarly service rate limit was reached.',
  SCHOLARLY_UPSTREAM_ERROR: 'The scholarly service failed or could not be reached.',
  SCHOLARLY_TIMEOUT: 'The scholarly service did not answer in time.',
  SCHOLARLY_INVALID_INPUT: 'The request to the scholarly service is invalid.',
  SCHOLARLY_CONFIG_MISSING: 'Required scholarly service configuration is missing.',
  SCHOLARLY_PARSE_ERROR: 'The scholarly service returned an unexpected payload.',
};

/**
 * Typed error for every failure in this package.
 *
 * Messages are fixed per code and only carry the provider, HTTP status and
 * configuration variable names. They never include the query text, titles,
 * identifiers or upstream payloads (engineering rule 11: no research content in logs).
 */
export class ScholarlyError extends Error {
  readonly code: ScholarlyErrorCode;
  readonly provider: ProviderId | undefined;
  readonly status: number | undefined;
  readonly retryAfterMs: number | undefined;
  readonly variables: readonly string[];
  readonly issuePaths: readonly string[];

  constructor(code: ScholarlyErrorCode, details: ScholarlyErrorDetails = {}) {
    const parts = [MESSAGES[code]];
    if (details.provider !== undefined) parts.push(`provider=${details.provider}`);
    if (details.status !== undefined) parts.push(`status=${details.status}`);
    if (details.variables !== undefined && details.variables.length > 0) {
      parts.push(`variables=${details.variables.join(',')}`);
    }
    super(parts.join(' '), details.cause === undefined ? undefined : { cause: details.cause });
    this.name = 'ScholarlyError';
    this.code = code;
    this.provider = details.provider;
    this.status = details.status;
    this.retryAfterMs = details.retryAfterMs;
    this.variables = details.variables ?? [];
    this.issuePaths = details.issuePaths ?? [];
  }
}

export function isScholarlyError(
  value: unknown,
  code?: ScholarlyErrorCode,
): value is ScholarlyError {
  return value instanceof ScholarlyError && (code === undefined || value.code === code);
}
