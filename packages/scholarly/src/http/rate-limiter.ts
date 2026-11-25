import { ScholarlyError } from '../errors';
import { DEFAULT_HOST_POLICY, HOST_POLICIES, ROUTE_POLICIES, type HostPolicy } from './policies';

export type Clock = () => number;
export type Sleep = (ms: number, signal?: AbortSignal) => Promise<void>;

function abortReason(signal: AbortSignal): Error {
  const reason: unknown = signal.reason;
  return reason instanceof Error ? reason : new DOMException('Aborted', 'AbortError');
}

/** setTimeout-based sleep (works with fake timers) that rejects when the signal aborts. */
export const defaultSleep: Sleep = (ms, signal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(abortReason(signal));
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(abortReason(signal as AbortSignal));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });

/**
 * Classic token bucket: `capacity` tokens, refilled continuously at `refillPerSecond`.
 * Waiters are served strictly in arrival order (FIFO), so a burst of calls is spread out
 * at the refill rate instead of racing for tokens.
 */
export class TokenBucket {
  private tokens: number;
  private lastRefill: number;
  private queue: Promise<void> = Promise.resolve();

  constructor(
    readonly capacity: number,
    readonly refillPerSecond: number,
    private readonly now: Clock = Date.now,
    private readonly sleep: Sleep = defaultSleep,
  ) {
    if (!(capacity >= 1) || !(refillPerSecond > 0)) {
      throw new ScholarlyError('SCHOLARLY_INVALID_INPUT');
    }
    this.tokens = capacity;
    this.lastRefill = now();
  }

  private refill(): void {
    const current = this.now();
    const elapsedSeconds = Math.max(0, current - this.lastRefill) / 1000;
    this.tokens = Math.min(this.capacity, this.tokens + elapsedSeconds * this.refillPerSecond);
    this.lastRefill = current;
  }

  /** Takes a token if one is available and returns 0; otherwise returns the wait in ms. */
  tryRemoveToken(): number {
    this.refill();
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return 0;
    }
    return Math.ceil(((1 - this.tokens) / this.refillPerSecond) * 1000);
  }

  /** Resolves once a token has been taken for the caller. */
  acquire(signal?: AbortSignal): Promise<void> {
    const take = async (): Promise<void> => {
      for (;;) {
        signal?.throwIfAborted();
        const wait = this.tryRemoveToken();
        if (wait === 0) return;
        await this.sleep(wait, signal);
      }
    };
    const turn = this.queue.then(take);
    this.queue = turn.catch(() => undefined);
    return turn;
  }
}

/** Counting semaphore with direct hand-off to the next waiter. */
export class Semaphore {
  private active = 0;
  private readonly waiters: (() => void)[] = [];

  constructor(readonly max: number) {}

  async acquire(signal?: AbortSignal): Promise<() => void> {
    signal?.throwIfAborted();
    if (this.active < this.max) {
      this.active += 1;
    } else {
      await new Promise<void>((resolve, reject) => {
        const waiter = (): void => {
          signal?.removeEventListener('abort', onAbort);
          resolve();
        };
        const onAbort = (): void => {
          const index = this.waiters.indexOf(waiter);
          if (index !== -1) this.waiters.splice(index, 1);
          reject(abortReason(signal as AbortSignal));
        };
        this.waiters.push(waiter);
        signal?.addEventListener('abort', onAbort, { once: true });
      });
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.waiters.shift();
      if (next === undefined) this.active -= 1;
      else next();
    };
  }
}

/** Fixed-window counter per UTC day. */
export class DailyQuota {
  private day = '';
  private used = 0;

  constructor(
    readonly limit: number,
    private readonly now: Clock = Date.now,
  ) {}

  tryTake(): boolean {
    const day = new Date(this.now()).toISOString().slice(0, 10);
    if (day !== this.day) {
      this.day = day;
      this.used = 0;
    }
    if (this.used >= this.limit) return false;
    this.used += 1;
    return true;
  }
}

/** All limits for one host: daily quota, concurrency, then the token bucket. */
export class HostLimiter {
  private readonly bucket: TokenBucket;
  private readonly semaphore: Semaphore | undefined;
  private readonly quota: DailyQuota | undefined;

  constructor(
    readonly policy: Pick<HostPolicy, 'ratePerSecond' | 'burst' | 'maxConcurrent' | 'dailyLimit'> &
      Partial<Pick<HostPolicy, 'provider'>>,
    now: Clock = Date.now,
    sleep: Sleep = defaultSleep,
  ) {
    this.bucket = new TokenBucket(policy.burst, policy.ratePerSecond, now, sleep);
    this.semaphore =
      policy.maxConcurrent === undefined ? undefined : new Semaphore(policy.maxConcurrent);
    this.quota =
      policy.dailyLimit === undefined ? undefined : new DailyQuota(policy.dailyLimit, now);
  }

  /**
   * Waits for a slot and returns its release function. Throws SCHOLARLY_RATE_LIMITED without
   * waiting when the local daily quota is spent.
   */
  async acquire(signal?: AbortSignal): Promise<() => void> {
    if (this.quota !== undefined && !this.quota.tryTake()) {
      throw new ScholarlyError(
        'SCHOLARLY_RATE_LIMITED',
        this.policy.provider === undefined ? {} : { provider: this.policy.provider },
      );
    }
    const release =
      this.semaphore === undefined ? () => undefined : await this.semaphore.acquire(signal);
    try {
      await this.bucket.acquire(signal);
    } catch (error) {
      release();
      throw error;
    }
    return release;
  }
}

/**
 * One limiter per pool (a host's default pool is keyed by the host name; separately metered
 * routes by `HostPolicy.pool`), created on first use. Share one registry per process.
 */
export class RateLimiterRegistry {
  private readonly limiters = new Map<string, HostLimiter>();
  private readonly policiesByHost: Map<string, HostPolicy>;

  constructor(
    policies: Record<string, HostPolicy> = { ...HOST_POLICIES, ...ROUTE_POLICIES },
    private readonly now: Clock = Date.now,
    private readonly sleep: Sleep = defaultSleep,
  ) {
    this.policiesByHost = new Map(
      Object.values(policies).map((policy) => [policy.pool ?? policy.host, policy]),
    );
  }

  /** Limiter for a host's default pool, or for a pool name such as CROSSREF_LIST_POOL. */
  forHost(host: string): HostLimiter {
    let limiter = this.limiters.get(host);
    if (limiter === undefined) {
      const policy = this.policiesByHost.get(host) ?? DEFAULT_HOST_POLICY;
      limiter = new HostLimiter(policy, this.now, this.sleep);
      this.limiters.set(host, limiter);
    }
    return limiter;
  }
}
