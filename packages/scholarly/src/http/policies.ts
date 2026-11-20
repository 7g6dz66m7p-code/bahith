import type { ProviderId } from '../types';

export interface HostPolicy {
  provider: ProviderId;
  host: string;
  /** Sustained requests per second (token refill rate). */
  ratePerSecond: number;
  /** Bucket capacity: how many requests may go out back to back. */
  burst: number;
  /** Maximum requests in flight at once, when the service states one. */
  maxConcurrent?: number;
  /** Requests per UTC day this process will send before refusing locally. */
  dailyLimit?: number;
  /** The client refuses to call without SCHOLARLY_CONTACT_EMAIL. */
  requiresContactEmail: boolean;
}

/**
 * Usage limits, encoded conservatively. Sources: each service's published usage policy as
 * summarised in the task brief, cross-checked against the rate-limit headers the live APIs
 * returned on 2026-11-19 (noted per entry). Limits are per process; several app instances
 * need a shared (Redis) limiter, which is out of scope here.
 */
export const HOST_POLICIES: Record<ProviderId, HostPolicy> = {
  // Polite pool (mailto). Live headers: `x-rate-limit-limit: 10`, `x-rate-limit-interval: 1s`,
  // `x-concurrency-limit: 3`, `x-api-pool: polite-single`. That is lower than the ~50 req/s
  // historically documented, so the observed value wins.
  crossref: {
    provider: 'crossref',
    host: 'api.crossref.org',
    ratePerSecond: 10,
    burst: 10,
    maxConcurrent: 3,
    requiresContactEmail: true,
  },
  // 10 req/s and 100k/day with mailto. Live headers show OpenAlex now meters usage in credits
  // (`x-ratelimit-limit-usd`); anonymous search answered 429 with Retry-After, so an API key is
  // strongly recommended (OPENALEX_API_KEY).
  openalex: {
    provider: 'openalex',
    host: 'api.openalex.org',
    ratePerSecond: 10,
    burst: 10,
    dailyLimit: 100_000,
    requiresContactEmail: true,
  },
  // Unauthenticated pool is shared by everyone: about 1 req/s.
  semanticscholar: {
    provider: 'semanticscholar',
    host: 'api.semanticscholar.org',
    ratePerSecond: 1,
    burst: 1,
    requiresContactEmail: false,
  },
  // NCBI: 3 req/s without an API key.
  pubmed: {
    provider: 'pubmed',
    host: 'eutils.ncbi.nlm.nih.gov',
    ratePerSecond: 3,
    burst: 3,
    requiresContactEmail: false,
  },
  // arXiv API terms: no more than one request every three seconds, one connection at a time.
  arxiv: {
    provider: 'arxiv',
    host: 'export.arxiv.org',
    ratePerSecond: 1 / 3,
    burst: 1,
    maxConcurrent: 1,
    requiresContactEmail: false,
  },
  // DOAJ API: 2 req/s (excess requests are queued, then rejected with 429).
  doaj: {
    provider: 'doaj',
    host: 'doaj.org',
    ratePerSecond: 2,
    burst: 2,
    requiresContactEmail: false,
  },
  // ORCID public API: 24 req/s with bursts of 40.
  orcid: {
    provider: 'orcid',
    host: 'pub.orcid.org',
    ratePerSecond: 24,
    burst: 40,
    requiresContactEmail: false,
  },
  // Unpaywall: email required on every call, 100k calls/day. No per-second figure is published;
  // 10 req/s keeps a single process far from the daily ceiling.
  unpaywall: {
    provider: 'unpaywall',
    host: 'api.unpaywall.org',
    ratePerSecond: 10,
    burst: 10,
    dailyLimit: 100_000,
    requiresContactEmail: true,
  },
};

/** Fallback for a host this package does not know (should not happen in practice). */
export const DEFAULT_HOST_POLICY: Omit<HostPolicy, 'provider' | 'host'> = {
  ratePerSecond: 1,
  burst: 1,
  requiresContactEmail: false,
};
