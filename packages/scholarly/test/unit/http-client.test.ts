import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { ScholarlyError } from '../../src/errors';
import { cacheKey, MemoryLruCache } from '../../src/http/cache';
import { HttpClient, parseRetryAfter, sanitizeUrl, type FetchLike } from '../../src/http/client';
import { testHttp } from '../helpers/fixtures';

const QUERY = 'secret research question about tashkeel';
const url = () => {
  const u = new URL('https://api.crossref.org/works');
  u.searchParams.set('query', QUERY);
  u.searchParams.set('mailto', 'bahith-dev@example.org');
  return u;
};
const schema = z.object({ ok: z.boolean() });

function scripted(responses: (Response | Error)[]) {
  const calls: string[] = [];
  const fetchImpl: FetchLike = (input) => {
    calls.push(input);
    const next = responses.shift();
    if (next === undefined) return Promise.reject(new Error('no more scripted responses'));
    return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
  };
  return { fetchImpl, calls };
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });

async function codeOf(promise: Promise<unknown>): Promise<string> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  if (!(error instanceof ScholarlyError)) throw new Error('expected a ScholarlyError');
  expect(error.message).not.toContain(QUERY);
  expect(error.message).not.toContain('bahith-dev');
  return error.code;
}

describe('HttpClient retries and backoff', () => {
  it('retries 503 with exponential backoff and jitter, then succeeds', async () => {
    const { fetchImpl, calls } = scripted([json({}, 503), json({}, 502), json({ ok: true })]);
    const { http, clock } = testHttp(fetchImpl);
    const { data } = await http.getJson({ provider: 'crossref', url: url() }, schema);
    expect(data).toEqual({ ok: true });
    expect(calls).toHaveLength(3);
    // base 500 ms, equal jitter with random()=0.5: attempt 0 → 375 ms, attempt 1 → 750 ms
    expect(clock.state.slept).toEqual([375, 750]);
  });

  it('keeps backoff within [ceiling/2, ceiling] and capped at maxDelayMs', () => {
    const low = new HttpClient({ random: () => 0, baseDelayMs: 500, maxDelayMs: 8000 });
    const high = new HttpClient({ random: () => 1, baseDelayMs: 500, maxDelayMs: 8000 });
    expect([0, 1, 2, 3, 10].map((n) => low.backoffDelay(n))).toEqual([250, 500, 1000, 2000, 4000]);
    expect([0, 1, 2, 3, 10].map((n) => high.backoffDelay(n))).toEqual([
      500, 1000, 2000, 4000, 8000,
    ]);
  });

  it('honours Retry-After on 429', async () => {
    const { fetchImpl } = scripted([json({}, 429, { 'retry-after': '2' }), json({ ok: true })]);
    const { http, clock } = testHttp(fetchImpl);
    await http.getJson({ provider: 'crossref', url: url() }, schema);
    expect(clock.state.slept).toEqual([2000]);
  });

  it('gives up at once with RATE_LIMITED when Retry-After exceeds the maximum wait', async () => {
    const { fetchImpl, calls } = scripted([json({}, 429, { 'retry-after': '3600' })]);
    const { http } = testHttp(fetchImpl);
    const error = await http.get({ provider: 'openalex', url: url() }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ScholarlyError);
    expect((error as ScholarlyError).code).toBe('SCHOLARLY_RATE_LIMITED');
    expect((error as ScholarlyError).retryAfterMs).toBe(3_600_000);
    expect(calls).toHaveLength(1);
  });

  it('stops after maxRetries (3) and reports RATE_LIMITED for a persistent 429', async () => {
    const { fetchImpl, calls } = scripted([429, 429, 429, 429].map((s) => json({}, s)));
    const { http } = testHttp(fetchImpl);
    expect(await codeOf(http.get({ provider: 'crossref', url: url() }))).toBe(
      'SCHOLARLY_RATE_LIMITED',
    );
    expect(calls).toHaveLength(4);
  });

  it('maps a persistent 5xx to UPSTREAM_ERROR', async () => {
    const { fetchImpl, calls } = scripted([500, 500, 500, 500].map((s) => json({}, s)));
    const { http } = testHttp(fetchImpl);
    expect(await codeOf(http.get({ provider: 'crossref', url: url() }))).toBe(
      'SCHOLARLY_UPSTREAM_ERROR',
    );
    expect(calls).toHaveLength(4);
  });

  it('retries network errors and then reports UPSTREAM_ERROR without the URL', async () => {
    const failure = new TypeError(`fetch failed for ${url().href}`);
    const { fetchImpl, calls } = scripted([failure, failure, failure, failure]);
    const { http } = testHttp(fetchImpl);
    const error = await http.get({ provider: 'crossref', url: url() }).catch((e: unknown) => e);
    expect((error as ScholarlyError).code).toBe('SCHOLARLY_UPSTREAM_ERROR');
    expect(String((error as ScholarlyError).cause)).toBe('TypeError');
    expect(calls).toHaveLength(4);
  });

  it('maps 404 to NOT_FOUND without retrying, and 400 to INVALID_INPUT', async () => {
    const notFound = scripted([new Response('Resource not found.', { status: 404 })]);
    expect(
      await codeOf(testHttp(notFound.fetchImpl).http.get({ provider: 'crossref', url: url() })),
    ).toBe('SCHOLARLY_NOT_FOUND');
    expect(notFound.calls).toHaveLength(1);
    const bad = scripted([json({}, 400)]);
    expect(
      await codeOf(testHttp(bad.fetchImpl).http.get({ provider: 'crossref', url: url() })),
    ).toBe('SCHOLARLY_INVALID_INPUT');
    const forbidden = scripted([json({}, 403)]);
    expect(
      await codeOf(testHttp(forbidden.fetchImpl).http.get({ provider: 'crossref', url: url() })),
    ).toBe('SCHOLARLY_UPSTREAM_ERROR');
  });

  it('reports PARSE_ERROR for malformed JSON and for schema violations (paths only)', async () => {
    const malformed = scripted([new Response('{"ok": tru', { status: 200 })]);
    expect(
      await codeOf(
        testHttp(malformed.fetchImpl).http.getJson({ provider: 'crossref', url: url() }, schema),
      ),
    ).toBe('SCHOLARLY_PARSE_ERROR');
    const wrongShape = scripted([json({ ok: QUERY })]);
    const error = await testHttp(wrongShape.fetchImpl)
      .http.getJson({ provider: 'crossref', url: url() }, schema)
      .catch((e: unknown) => e);
    expect((error as ScholarlyError).code).toBe('SCHOLARLY_PARSE_ERROR');
    expect((error as ScholarlyError).issuePaths).toEqual(['ok']);
    expect(JSON.stringify(error)).not.toContain(QUERY);
  });

  it('propagates a caller abort untouched instead of retrying', async () => {
    const controller = new AbortController();
    const fetchImpl: FetchLike = (_input, init) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => {
          reject(new DOMException('aborted', 'AbortError'));
        });
      });
    const { http } = testHttp(fetchImpl);
    const pending = http.get({ provider: 'crossref', url: url(), signal: controller.signal });
    controller.abort(new Error('caller cancelled'));
    await expect(pending).rejects.toThrow('caller cancelled');
  });
});

describe('HttpClient timeout (fake timers)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('aborts a hanging request after timeoutMs and reports TIMEOUT', async () => {
    vi.useFakeTimers();
    let aborted = false;
    const fetchImpl: FetchLike = (_input, init) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => {
          aborted = true;
          reject(new DOMException('timeout', 'TimeoutError'));
        });
      });
    const http = new HttpClient({ fetch: fetchImpl, timeoutMs: 10_000, maxRetries: 0 });
    const pending = http.get({ provider: 'crossref', url: url() });
    const assertion = expect(pending).rejects.toMatchObject({ code: 'SCHOLARLY_TIMEOUT' });
    await vi.advanceTimersByTimeAsync(9_999);
    expect(aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await assertion;
    expect(aborted).toBe(true);
  });

  it('defaults to a 10 s timeout and retries timeouts up to 3 times', async () => {
    vi.useFakeTimers();
    let attempts = 0;
    const fetchImpl: FetchLike = (_input, init) => {
      attempts += 1;
      return new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => {
          reject(new DOMException('timeout', 'TimeoutError'));
        });
      });
    };
    const http = new HttpClient({ fetch: fetchImpl, random: () => 0 });
    const pending = http.get({ provider: 'crossref', url: url() });
    const assertion = expect(pending).rejects.toMatchObject({ code: 'SCHOLARLY_TIMEOUT' });
    await vi.advanceTimersByTimeAsync(4 * 10_000 + 250 + 500 + 1000);
    await assertion;
    expect(attempts).toBe(4);
  });
});

describe('HttpClient cache', () => {
  it('serves repeated requests from the cache, including negative (404) entries', async () => {
    const cache = new MemoryLruCache(10);
    const { fetchImpl, calls } = scripted([json({ ok: true }), new Response('', { status: 404 })]);
    const { http } = testHttp(fetchImpl, { cache });
    const first = await http.get({ provider: 'crossref', url: url(), cacheTtlMs: 60_000 });
    const second = await http.get({ provider: 'crossref', url: url(), cacheTtlMs: 60_000 });
    expect(second.fromCache).toBe(true);
    expect(second.body).toBe(first.body);
    expect(second.receivedAt.toISOString()).toBe(first.receivedAt.toISOString());

    const missing = new URL('https://api.crossref.org/works/10.9999/x');
    const request = { provider: 'crossref' as const, url: missing, notFoundTtlMs: 60_000 };
    expect(await codeOf(http.get(request))).toBe('SCHOLARLY_NOT_FOUND');
    expect(await codeOf(http.get(request))).toBe('SCHOLARLY_NOT_FOUND');
    expect(calls).toHaveLength(2);
  });

  it('ignores corrupt cache entries', async () => {
    const cache = new MemoryLruCache(10);
    await cache.set(cacheKey('crossref', sanitizeUrl(url())), 'not json', 60_000);
    const { fetchImpl, calls } = scripted([json({ ok: true })]);
    const { http } = testHttp(fetchImpl, { cache });
    const response = await http.get({ provider: 'crossref', url: url() });
    expect(response.fromCache).toBe(false);
    expect(calls).toHaveLength(1);
  });
});

describe('URL and header helpers', () => {
  it('strips the contact email and keys from stored URLs', () => {
    const u = url();
    u.searchParams.set('api_key', 'k-123456789');
    u.searchParams.set('email', 'bahith-dev@example.org');
    u.searchParams.set('tool', 'BAHITH');
    const safe = sanitizeUrl(u);
    expect(safe).not.toMatch(/mailto|email|api_key|tool=/u);
    expect(safe).toContain('query=');
  });

  it('parses Retry-After seconds and HTTP dates', () => {
    const now = Date.parse('2026-11-19T12:00:00Z');
    expect(parseRetryAfter('5', now)).toBe(5000);
    expect(parseRetryAfter('Thu, 19 Nov 2026 12:00:30 GMT', now)).toBe(30_000);
    expect(parseRetryAfter('garbage', now)).toBeUndefined();
    expect(parseRetryAfter(null, now)).toBeUndefined();
  });
});
