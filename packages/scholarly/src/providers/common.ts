import { z } from 'zod';

import type { ScholarlyConfig } from '../config';
import { userAgent } from '../config';
import { ScholarlyError } from '../errors';
import type { HttpClient } from '../http/client';
import type { ProviderId } from '../types';

export interface ProviderContext {
  http: HttpClient;
  config: ScholarlyConfig;
}

export interface CallOptions {
  signal?: AbortSignal;
}

/** Cache lifetimes: metadata records change rarely; searches and OA status more often. */
export const CACHE_TTL = {
  record: 7 * 24 * 60 * 60 * 1000,
  search: 24 * 60 * 60 * 1000,
  notFound: 24 * 60 * 60 * 1000,
  openAccess: 24 * 60 * 60 * 1000,
} as const;

export function baseHeaders(
  config: ScholarlyConfig,
  accept = 'application/json',
): Record<string, string> {
  return { Accept: accept, 'User-Agent': userAgent(config) };
}

/** Upper bound on the length of free-text queries sent upstream. */
export const MAX_QUERY_CHARS = 500;

export function requireQuery(provider: ProviderId, query: string): string {
  const trimmed = query.trim();
  if (trimmed === '' || trimmed.length > MAX_QUERY_CHARS) {
    throw new ScholarlyError('SCHOLARLY_INVALID_INPUT', { provider });
  }
  return trimmed;
}

export function requireLimit(
  provider: ProviderId,
  value: number | undefined,
  fallback: number,
  max: number,
): number {
  const limit = value ?? fallback;
  if (!Number.isInteger(limit) || limit < 1 || limit > max) {
    throw new ScholarlyError('SCHOLARLY_INVALID_INPUT', { provider });
  }
  return limit;
}

/** Zod helpers for upstream JSON that uses null and absent interchangeably. */
export const optString = z.string().nullish();
export const optNumber = z.number().nullish();
export const optStringOrNumber = z.union([z.string(), z.number()]).nullish();

export function asString(value: string | number | null | undefined): string | undefined {
  if (value === null || value === undefined) return undefined;
  return String(value);
}
