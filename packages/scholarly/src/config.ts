import { z } from 'zod';

import { ScholarlyError } from './errors';
import type { ProviderId } from './types';

export interface ScholarlyConfig {
  /**
   * Contact address sent to the services that ask for one (Crossref polite pool `mailto`,
   * OpenAlex `mailto`, Unpaywall `email`, NCBI `email`). Required by Crossref, OpenAlex and
   * Unpaywall clients: without it they refuse to call rather than calling anonymously.
   */
  contactEmail?: string;
  /** Optional OpenAlex API key (sent as `api_key`). Anonymous search is heavily throttled. */
  openAlexApiKey?: string;
  /** Optional Semantic Scholar API key (sent as `x-api-key`). */
  semanticScholarApiKey?: string;
  /** Optional NCBI E-utilities API key (sent as `api_key`). */
  ncbiApiKey?: string;
  /** Application name sent in User-Agent and as NCBI `tool`. */
  appName: string;
}

const blankToUndefined = (value: unknown): unknown =>
  typeof value === 'string' && value.trim() === '' ? undefined : value;

const optionalSecret = z.preprocess(blankToUndefined, z.string().trim().min(8).optional());

const envSchema = z.object({
  SCHOLARLY_CONTACT_EMAIL: z.preprocess(blankToUndefined, z.email().optional()),
  OPENALEX_API_KEY: optionalSecret,
  SEMANTIC_SCHOLAR_API_KEY: optionalSecret,
  NCBI_API_KEY: optionalSecret,
});

/** Variables this package reads. Values are never logged or put in error messages. */
export const SCHOLARLY_ENV_VARIABLES = [
  'SCHOLARLY_CONTACT_EMAIL',
  'OPENALEX_API_KEY',
  'SEMANTIC_SCHOLAR_API_KEY',
  'NCBI_API_KEY',
] as const;

/**
 * Reads the scholarly configuration from the environment. Every variable is optional here;
 * a malformed value is a configuration error (reported by variable name only).
 */
export function loadScholarlyConfig(
  env: Record<string, string | undefined> = process.env,
): ScholarlyConfig {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const variables = [...new Set(parsed.error.issues.map((issue) => String(issue.path[0])))];
    throw new ScholarlyError('SCHOLARLY_CONFIG_MISSING', { variables });
  }
  const config: ScholarlyConfig = { appName: 'BAHITH' };
  const data = parsed.data;
  if (data.SCHOLARLY_CONTACT_EMAIL !== undefined)
    config.contactEmail = data.SCHOLARLY_CONTACT_EMAIL;
  if (data.OPENALEX_API_KEY !== undefined) config.openAlexApiKey = data.OPENALEX_API_KEY;
  if (data.SEMANTIC_SCHOLAR_API_KEY !== undefined) {
    config.semanticScholarApiKey = data.SEMANTIC_SCHOLAR_API_KEY;
  }
  if (data.NCBI_API_KEY !== undefined) config.ncbiApiKey = data.NCBI_API_KEY;
  return config;
}

/** Returns the contact email or throws SCHOLARLY_CONFIG_MISSING before any request is made. */
export function requireContactEmail(config: ScholarlyConfig, provider: ProviderId): string {
  const email = config.contactEmail;
  if (email === undefined || !z.email().safeParse(email).success) {
    throw new ScholarlyError('SCHOLARLY_CONFIG_MISSING', {
      provider,
      variables: ['SCHOLARLY_CONTACT_EMAIL'],
    });
  }
  return email;
}

/** User-Agent per the Crossref etiquette: application name plus a mailto when known. */
export function userAgent(config: ScholarlyConfig): string {
  const base = `${config.appName}-scholarly/0.1`;
  return config.contactEmail === undefined ? base : `${base} (mailto:${config.contactEmail})`;
}
