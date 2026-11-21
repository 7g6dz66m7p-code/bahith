import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { isScholarlyError } from '../../src/errors';
import { HOST_POLICIES } from '../../src/http/policies';
import {
  DailyQuota,
  HostLimiter,
  RateLimiterRegistry,
  Semaphore,
  TokenBucket,
} from '../../src/http/rate-limiter';

describe('TokenBucket (fake timers)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-19T12:00:00Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('lets a burst through, then spaces requests at the refill rate', async () => {
    const bucket = new TokenBucket(2, 1);
    const done: (number | undefined)[] = [];
    const start = Date.now();
    const waiters = [0, 1, 2, 3].map((i) =>
      bucket.acquire().then(() => {
        done[i] = Date.now() - start;
      }),
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(done.filter((t) => t !== undefined)).toEqual([0, 0]);
    await vi.advanceTimersByTimeAsync(999);
    expect(done[2]).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(done[2]).toBe(1000);
    await vi.advanceTimersByTimeAsync(1000);
    await Promise.all(waiters);
    expect(done).toEqual([0, 0, 1000, 2000]);
  });

  it('enforces the arXiv policy of one request every three seconds', async () => {
    const limiter = new HostLimiter(HOST_POLICIES.arxiv);
    const times: number[] = [];
    const start = Date.now();
    const run = async () => {
      const release = await limiter.acquire();
      times.push(Date.now() - start);
      release();
    };
    const all = Promise.all([run(), run(), run()]);
    await vi.advanceTimersByTimeAsync(2999);
    expect(times).toEqual([0]);
    await vi.advanceTimersByTimeAsync(1);
    expect(times).toEqual([0, 3000]);
    await vi.advanceTimersByTimeAsync(3000);
    await all;
    expect(times).toEqual([0, 3000, 6000]);
  });

  it('honours an abort signal while waiting and keeps serving later callers', async () => {
    const bucket = new TokenBucket(1, 1);
    await bucket.acquire();
    const controller = new AbortController();
    const aborted = bucket.acquire(controller.signal);
    const assertion = expect(aborted).rejects.toThrow();
    controller.abort();
    await assertion;
    const next = bucket.acquire();
    await vi.advanceTimersByTimeAsync(1000);
    await expect(next).resolves.toBeUndefined();
  });

  it('rejects invalid configuration', () => {
    expect(() => new TokenBucket(0, 1)).toThrow();
    expect(() => new TokenBucket(1, 0)).toThrow();
  });
});

describe('Semaphore', () => {
  it('limits concurrency and hands slots over in order', async () => {
    const semaphore = new Semaphore(2);
    const a = await semaphore.acquire();
    const b = await semaphore.acquire();
    let thirdAcquired = false;
    const third = semaphore.acquire().then((release) => {
      thirdAcquired = true;
      return release;
    });
    await Promise.resolve();
    expect(thirdAcquired).toBe(false);
    a();
    const c = await third;
    expect(thirdAcquired).toBe(true);
    a(); // releasing twice is a no-op
    b();
    c();
    const d = await semaphore.acquire();
    const e = await semaphore.acquire();
    d();
    e();
  });
});

describe('DailyQuota and HostLimiter', () => {
  it('refuses locally once the daily quota is spent and resets at UTC midnight', async () => {
    let now = Date.parse('2026-11-19T23:59:59Z');
    const quota = new DailyQuota(2, () => now);
    expect(quota.tryTake()).toBe(true);
    expect(quota.tryTake()).toBe(true);
    expect(quota.tryTake()).toBe(false);
    now = Date.parse('2026-11-20T00:00:01Z');
    expect(quota.tryTake()).toBe(true);

    const limiter = new HostLimiter({
      provider: 'unpaywall',
      ratePerSecond: 100,
      burst: 100,
      dailyLimit: 1,
    });
    (await limiter.acquire())();
    const error = await limiter.acquire().catch((e: unknown) => e);
    expect(isScholarlyError(error, 'SCHOLARLY_RATE_LIMITED')).toBe(true);
  });

  it('builds one limiter per host from the published policies', () => {
    const registry = new RateLimiterRegistry();
    const crossref = registry.forHost('api.crossref.org');
    expect(registry.forHost('api.crossref.org')).toBe(crossref);
    expect(crossref.policy.maxConcurrent).toBe(3);
    expect(registry.forHost('export.arxiv.org').policy.ratePerSecond).toBeCloseTo(1 / 3);
    expect(registry.forHost('unknown.example').policy.ratePerSecond).toBe(1);
  });

  it('encodes the documented limits for every provider', () => {
    expect(HOST_POLICIES.semanticscholar.ratePerSecond).toBe(1);
    expect(HOST_POLICIES.pubmed.ratePerSecond).toBe(3);
    expect(HOST_POLICIES.openalex.ratePerSecond).toBe(10);
    expect(HOST_POLICIES.openalex.dailyLimit).toBe(100_000);
    expect(HOST_POLICIES.unpaywall.dailyLimit).toBe(100_000);
    expect(HOST_POLICIES.crossref.requiresContactEmail).toBe(true);
    expect(HOST_POLICIES.openalex.requiresContactEmail).toBe(true);
    expect(HOST_POLICIES.unpaywall.requiresContactEmail).toBe(true);
  });
});
