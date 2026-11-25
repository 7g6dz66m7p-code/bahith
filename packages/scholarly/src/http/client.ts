import { z } from 'zod';

import { ScholarlyError } from '../errors';
import type { ProviderId } from '../types';
import { cacheKey, type ScholarlyCache } from './cache';
import { defaultSleep, RateLimiterRegistry, type Sleep } from './rate-limiter';

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export interface HttpClientOptions {
  /** Injectable fetch (tests, instrumentation). Defaults to the global fetch. */
  fetch?: FetchLike;
  /** Shared per-host limiter. Defaults to a new registry built from HOST_POLICIES. */
  limiter?: RateLimiterRegistry;
  /** Optional response cache; nothing is cached without one. */
  cache?: ScholarlyCache;
  /** Per-attempt timeout covering connect, headers and body. Default 10 s. */
  timeoutMs?: number;
  /** Retries after the first attempt for 429/5xx/network/timeout. Default 3. */
  maxRetries?: number;
  /** Backoff base: attempt n waits within [b·2ⁿ/2, b·2ⁿ] (equal jitter). Default 500 ms. */
  baseDelayMs?: number;
  /** Cap for one computed backoff delay. Default 8 s. */
  maxDelayMs?: number;
  /**
   * Longest Retry-After this client will wait for. A longer one ends the call at once with
   * SCHOLARLY_RATE_LIMITED (carrying `retryAfterMs`) so the caller can reschedule. Default 60 s.
   */
  maxRetryAfterMs?: number;
  /** Largest response body accepted, in characters. Default 5 MB. */
  maxBodyChars?: number;
  random?: () => number;
  sleep?: Sleep;
  now?: () => number;
}

export interface HttpRequest {
  provider: ProviderId;
  url: URL;
  headers?: Record<string, string>;
  /** Limiter pool for a separately metered route (e.g. CROSSREF_LIST_POOL). Default: the host. */
  rateLimitPool?: string;
  /** TTL for caching a 2xx body. Omit to skip caching. */
  cacheTtlMs?: number;
  /** TTL for caching a 404/410 (negative cache). Omit to skip. */
  notFoundTtlMs?: number;
  signal?: AbortSignal;
}

export interface HttpResponse {
  status: number;
  body: string;
  contentType: string | null;
  /** Request URL with the contact email and keys removed: safe for provenance and logs. */
  url: string;
  receivedAt: Date;
  fromCache: boolean;
}

/** Query parameters that identify us or authenticate; never stored or reported. */
export const SENSITIVE_QUERY_PARAMS = ['mailto', 'email', 'api_key', 'tool'] as const;

export function sanitizeUrl(url: URL): string {
  const copy = new URL(url.href);
  for (const name of SENSITIVE_QUERY_PARAMS) copy.searchParams.delete(name);
  return copy.href;
}

/** Parses Retry-After (delta-seconds or HTTP-date) into milliseconds from `now`. */
export function parseRetryAfter(value: string | null, now: number): number | undefined {
  if (value === null) return undefined;
  const trimmed = value.trim();
  if (/^\d+$/u.test(trimmed)) return Number(trimmed) * 1000;
  const date = Date.parse(trimmed);
  if (Number.isNaN(date)) return undefined;
  return Math.max(0, date - now);
}

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);
const NOT_FOUND_STATUS = new Set([404, 410]);

type Attempt =
  | { kind: 'response'; status: number; headers: Headers; body: string }
  | { kind: 'timeout' }
  | { kind: 'network'; cause: unknown };

const cachedEntrySchema = z.object({
  status: z.number().int(),
  body: z.string(),
  contentType: z.string().nullable(),
  receivedAt: z.string(),
});

/**
 * HTTP core shared by every provider client: rate limiting, timeout, bounded retries with
 * exponential backoff and jitter (honouring Retry-After), optional caching and typed errors.
 * Nothing here logs; errors carry only provider and status.
 */
export class HttpClient {
  private readonly fetchImpl: FetchLike;
  private readonly limiter: RateLimiterRegistry;
  private readonly cache: ScholarlyCache | undefined;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly baseDelayMs: number;
  private readonly maxDelayMs: number;
  private readonly maxRetryAfterMs: number;
  private readonly maxBodyChars: number;
  private readonly random: () => number;
  private readonly sleep: Sleep;
  private readonly now: () => number;

  constructor(options: HttpClientOptions = {}) {
    this.fetchImpl = options.fetch ?? ((input, init) => fetch(input, init));
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? defaultSleep;
    this.limiter = options.limiter ?? new RateLimiterRegistry(undefined, this.now, this.sleep);
    this.cache = options.cache;
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.maxRetries = options.maxRetries ?? 3;
    this.baseDelayMs = options.baseDelayMs ?? 500;
    this.maxDelayMs = options.maxDelayMs ?? 8_000;
    this.maxRetryAfterMs = options.maxRetryAfterMs ?? 60_000;
    this.maxBodyChars = options.maxBodyChars ?? 5_000_000;
    this.random = options.random ?? Math.random;
  }

  /** Backoff before retry number `attempt` (0-based), with equal jitter. */
  backoffDelay(attempt: number): number {
    const ceiling = Math.min(this.maxDelayMs, this.baseDelayMs * 2 ** attempt);
    return Math.round(ceiling / 2 + this.random() * (ceiling / 2));
  }

  /** GET returning the raw body of a 2xx response; every other outcome throws ScholarlyError. */
  async get(request: HttpRequest): Promise<HttpResponse> {
    const { provider } = request;
    const safeUrl = sanitizeUrl(request.url);
    const key = cacheKey(provider, safeUrl);

    if (this.cache !== undefined) {
      const cached = await this.readCache(key);
      if (cached !== undefined) {
        if (NOT_FOUND_STATUS.has(cached.status)) {
          throw new ScholarlyError('SCHOLARLY_NOT_FOUND', { provider, status: cached.status });
        }
        return {
          status: cached.status,
          body: cached.body,
          contentType: cached.contentType,
          url: safeUrl,
          receivedAt: new Date(cached.receivedAt),
          fromCache: true,
        };
      }
    }

    const limiter = this.limiter.forHost(request.rateLimitPool ?? request.url.host);
    for (let attempt = 0; ; attempt += 1) {
      const release = await limiter.acquire(request.signal);
      let outcome: Attempt;
      try {
        outcome = await this.attempt(request);
      } finally {
        release();
      }

      if (outcome.kind === 'response') {
        const { status } = outcome;
        if (status >= 200 && status < 300) {
          if (outcome.body.length > this.maxBodyChars) {
            throw new ScholarlyError('SCHOLARLY_PARSE_ERROR', { provider, status });
          }
          const response: HttpResponse = {
            status,
            body: outcome.body,
            contentType: outcome.headers.get('content-type'),
            url: safeUrl,
            receivedAt: new Date(this.now()),
            fromCache: false,
          };
          if (request.cacheTtlMs !== undefined) {
            await this.writeCache(key, response, request.cacheTtlMs);
          }
          return response;
        }
        if (NOT_FOUND_STATUS.has(status)) {
          if (request.notFoundTtlMs !== undefined) {
            await this.writeCache(
              key,
              {
                status,
                body: '',
                contentType: null,
                url: safeUrl,
                receivedAt: new Date(this.now()),
                fromCache: false,
              },
              request.notFoundTtlMs,
            );
          }
          throw new ScholarlyError('SCHOLARLY_NOT_FOUND', { provider, status });
        }
        if (!RETRYABLE_STATUS.has(status)) {
          throw new ScholarlyError(
            status === 400 || status === 422
              ? 'SCHOLARLY_INVALID_INPUT'
              : 'SCHOLARLY_UPSTREAM_ERROR',
            { provider, status },
          );
        }
        const retryAfterMs = parseRetryAfter(outcome.headers.get('retry-after'), this.now());
        const finalError = (): ScholarlyError =>
          new ScholarlyError(
            status === 429 ? 'SCHOLARLY_RATE_LIMITED' : 'SCHOLARLY_UPSTREAM_ERROR',
            retryAfterMs === undefined ? { provider, status } : { provider, status, retryAfterMs },
          );
        if (attempt >= this.maxRetries) throw finalError();
        if (retryAfterMs !== undefined && retryAfterMs > this.maxRetryAfterMs) throw finalError();
        await this.sleep(retryAfterMs ?? this.backoffDelay(attempt), request.signal);
        continue;
      }

      if (attempt >= this.maxRetries) {
        throw outcome.kind === 'timeout'
          ? new ScholarlyError('SCHOLARLY_TIMEOUT', { provider })
          : new ScholarlyError('SCHOLARLY_UPSTREAM_ERROR', {
              provider,
              cause: errorName(outcome.cause),
            });
      }
      await this.sleep(this.backoffDelay(attempt), request.signal);
    }
  }

  /** GET + JSON.parse + Zod validation. Upstream JSON is untrusted. */
  async getJson<T>(
    request: HttpRequest,
    schema: z.ZodType<T>,
  ): Promise<{ data: T; response: HttpResponse }> {
    const response = await this.get(request);
    return { data: parseJson(response.body, schema, request.provider), response };
  }

  private async attempt(request: HttpRequest): Promise<Attempt> {
    const controller = new AbortController();
    const external = request.signal;
    const onExternalAbort = (): void => {
      controller.abort(external?.reason);
    };
    external?.addEventListener('abort', onExternalAbort, { once: true });
    const timeout = { fired: false };
    const timer = setTimeout(() => {
      timeout.fired = true;
      controller.abort(new DOMException('The operation timed out.', 'TimeoutError'));
    }, this.timeoutMs);
    try {
      external?.throwIfAborted();
      const response = await this.fetchImpl(request.url.href, {
        method: 'GET',
        headers: request.headers ?? {},
        signal: controller.signal,
        redirect: 'follow',
      });
      const body = await response.text();
      return { kind: 'response', status: response.status, headers: response.headers, body };
    } catch (error) {
      // A caller-initiated abort is not an upstream failure: propagate it untouched.
      if (external?.aborted === true) throw external.reason;
      if (timeout.fired) return { kind: 'timeout' };
      return { kind: 'network', cause: error };
    } finally {
      clearTimeout(timer);
      external?.removeEventListener('abort', onExternalAbort);
    }
  }

  private async readCache(key: string): Promise<z.infer<typeof cachedEntrySchema> | undefined> {
    const raw = await (this.cache as ScholarlyCache).get(key);
    if (raw === undefined) return undefined;
    try {
      const parsed = cachedEntrySchema.safeParse(JSON.parse(raw));
      return parsed.success ? parsed.data : undefined;
    } catch {
      return undefined;
    }
  }

  private async writeCache(key: string, response: HttpResponse, ttlMs: number): Promise<void> {
    if (this.cache === undefined) return;
    const entry: z.infer<typeof cachedEntrySchema> = {
      status: response.status,
      body: response.body,
      contentType: response.contentType,
      receivedAt: response.receivedAt.toISOString(),
    };
    await this.cache.set(key, JSON.stringify(entry), ttlMs);
  }
}

/**
 * Network error causes can embed the request URL (and so the query text); only the error
 * name is kept.
 */
function errorName(error: unknown): string {
  return error instanceof Error ? error.name : 'UnknownError';
}

/** JSON.parse + schema validation; any failure is SCHOLARLY_PARSE_ERROR (paths only). */
export function parseJson<T>(body: string, schema: z.ZodType<T>, provider: ProviderId): T {
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    // The SyntaxError message quotes part of the body, so it is not attached.
    throw new ScholarlyError('SCHOLARLY_PARSE_ERROR', { provider });
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    throw new ScholarlyError('SCHOLARLY_PARSE_ERROR', {
      provider,
      issuePaths: parsed.error.issues.map((issue) => issue.path.map(String).join('.')),
    });
  }
  return parsed.data;
}
