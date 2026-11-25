import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { z } from 'zod';

import type { ScholarlyConfig } from '../../src/config';
import {
  HttpClient,
  sanitizeUrl,
  type FetchLike,
  type HttpClientOptions,
} from '../../src/http/client';
import { RateLimiterRegistry } from '../../src/http/rate-limiter';

const FIXTURE_DIR = resolve(import.meta.dirname, '../fixtures');

const manifestSchema = z.object({
  fixtures: z.record(
    z.string(),
    z.object({
      file: z.string(),
      url: z.string(),
      status: z.number().int(),
      contentType: z.string().nullable(),
    }),
  ),
});

const manifest = manifestSchema.parse(
  JSON.parse(readFileSync(join(FIXTURE_DIR, 'manifest.json'), 'utf8')),
).fixtures;

export interface Fixture {
  name: string;
  url: string;
  status: number;
  contentType: string | null;
  body: string;
}

/** A response recorded from the live API by scripts/record-fixtures.ts. */
export function fixture(name: string): Fixture {
  const entry = manifest[name];
  if (entry === undefined) throw new Error(`Unknown fixture ${name}`);
  return { name, ...entry, body: readFileSync(join(FIXTURE_DIR, entry.file), 'utf8') };
}

export function toResponse(f: Pick<Fixture, 'body' | 'status' | 'contentType'>): Response {
  const headers = new Headers();
  if (f.contentType !== null) headers.set('content-type', f.contentType);
  return new Response(f.status === 204 ? null : f.body, { status: f.status, headers });
}

/**
 * Fetch that serves recorded fixtures by exact (sanitised) URL. Requests nobody recorded are
 * collected in `unmatched` and fail like a network error, so tests can assert on both.
 */
export function fixtureFetch(names: string[] = Object.keys(manifest)) {
  const byUrl = new Map(names.map((name) => [fixture(name).url, fixture(name)]));
  const requests: string[] = [];
  const unmatched: string[] = [];
  const fetchImpl: FetchLike = (input) => {
    requests.push(input);
    const hit = byUrl.get(sanitizeUrl(new URL(input)));
    if (hit === undefined) {
      unmatched.push(sanitizeUrl(new URL(input)));
      return Promise.reject(new TypeError('fetch failed'));
    }
    return Promise.resolve(toResponse(hit));
  };
  return { fetch: fetchImpl, requests, unmatched };
}

/** Manual clock: `sleep` advances it instantly, so limiter waits and backoffs cost no time. */
export function manualClock(start = Date.UTC(2026, 10, 19, 12, 0, 0)) {
  const state = { now: start, slept: [] as number[] };
  return {
    state,
    now: () => state.now,
    sleep: (ms: number) => {
      state.slept.push(ms);
      state.now += ms;
      return Promise.resolve();
    },
  };
}

/** HttpClient with a manual clock (no real waiting) and deterministic jitter. */
export function testHttp(fetchImpl: FetchLike, options: HttpClientOptions = {}) {
  const clock = manualClock();
  const http = new HttpClient({
    fetch: fetchImpl,
    now: clock.now,
    sleep: clock.sleep,
    limiter: new RateLimiterRegistry(undefined, clock.now, clock.sleep),
    random: () => 0.5,
    ...options,
  });
  return { http, clock };
}

export const TEST_EMAIL = 'bahith-dev@example.org';

export const TEST_CONFIG: ScholarlyConfig = { appName: 'BAHITH', contactEmail: TEST_EMAIL };
