import type { ScholarlyConfig } from './config';
import { HttpClient, type HttpClientOptions } from './http/client';
import { ArxivClient } from './providers/arxiv';
import { CrossrefClient } from './providers/crossref';
import { DoajClient } from './providers/doaj';
import { OpenAlexClient } from './providers/openalex';
import { OrcidClient } from './providers/orcid';
import { PubmedClient } from './providers/pubmed';
import { SemanticScholarClient } from './providers/semantic-scholar';
import { UnpaywallClient } from './providers/unpaywall';

export {
  loadScholarlyConfig,
  requireContactEmail,
  SCHOLARLY_ENV_VARIABLES,
  type ScholarlyConfig,
} from './config';
export {
  isScholarlyError,
  SCHOLARLY_ERROR_CODES,
  ScholarlyError,
  type ScholarlyErrorCode,
  type ScholarlyErrorDetails,
} from './errors';
export { cacheKey, MemoryLruCache, type ScholarlyCache } from './http/cache';
export {
  HttpClient,
  parseRetryAfter,
  sanitizeUrl,
  SENSITIVE_QUERY_PARAMS,
  type FetchLike,
  type HttpClientOptions,
  type HttpRequest,
  type HttpResponse,
} from './http/client';
export { DEFAULT_HOST_POLICY, HOST_POLICIES, type HostPolicy } from './http/policies';
export {
  DailyQuota,
  defaultSleep,
  HostLimiter,
  RateLimiterRegistry,
  Semaphore,
  TokenBucket,
  type Clock,
  type Sleep,
} from './http/rate-limiter';
export { ArxivClient } from './providers/arxiv';
export type { CallOptions, ProviderContext } from './providers/common';
export { CrossrefClient } from './providers/crossref';
export { DoajClient } from './providers/doaj';
export { OpenAlexClient, reconstructAbstract } from './providers/openalex';
export { OrcidClient, type OrcidPerson } from './providers/orcid';
export { PubmedClient } from './providers/pubmed';
export { SemanticScholarClient } from './providers/semantic-scholar';
export {
  UnpaywallClient,
  type OpenAccessLocation,
  type OpenAccessResult,
} from './providers/unpaywall';
export {
  PROVIDER_IDS,
  type CslDate,
  type CslItem,
  type CslName,
  type CslType,
  type Provenance,
  type ProviderId,
  type ScholarlyRecord,
  type SearchResult,
} from './types';
export {
  isValidOrcid,
  normalizeArxivId,
  normalizeDoi,
  normalizeOrcid,
  normalizePmid,
  orcidCheckDigit,
} from './util/ids';
export { normalizeText, titleSimilarity, tokenJaccard, levenshteinRatio } from './util/text';
export {
  CONTAINER_JACCARD_THRESHOLD,
  CONTAINER_LEVENSHTEIN_THRESHOLD,
  SEARCH_ROWS,
  TITLE_SIMILARITY_THRESHOLD,
  VERIFICATION_REASONS,
  verifyReference,
  YEAR_TOLERANCE,
  type ReferenceCandidate,
  type VerificationChecks,
  type VerificationDeps,
  type VerificationReason,
  type VerificationResult,
  type VerificationStatus,
} from './verify';

export interface ScholarlyClients {
  http: HttpClient;
  crossref: CrossrefClient;
  openalex: OpenAlexClient;
  semanticScholar: SemanticScholarClient;
  pubmed: PubmedClient;
  arxiv: ArxivClient;
  doaj: DoajClient;
  orcid: OrcidClient;
  unpaywall: UnpaywallClient;
}

/**
 * All clients sharing one HTTP core (one rate limiter per host, one cache). Create once per
 * process: separate instances have separate limiters and would exceed the published limits.
 */
export function createScholarlyClients(
  config: ScholarlyConfig,
  httpOptions: HttpClientOptions = {},
): ScholarlyClients {
  const http = new HttpClient(httpOptions);
  const ctx = { http, config };
  return {
    http,
    crossref: new CrossrefClient(ctx),
    openalex: new OpenAlexClient(ctx),
    semanticScholar: new SemanticScholarClient(ctx),
    pubmed: new PubmedClient(ctx),
    arxiv: new ArxivClient(ctx),
    doaj: new DoajClient(ctx),
    orcid: new OrcidClient(ctx),
    unpaywall: new UnpaywallClient(ctx),
  };
}
