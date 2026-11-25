import { createHash } from 'node:crypto';

/**
 * Response cache. Values are opaque strings; implementations must honour `ttlMs`.
 * The in-memory LRU below is the default; the app can plug a Redis-backed implementation.
 */
export interface ScholarlyCache {
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string, ttlMs: number): Promise<void>;
}

interface Entry {
  value: string;
  expiresAt: number;
}

/** Size-bounded LRU with per-entry TTL. Map insertion order doubles as recency order. */
export class MemoryLruCache implements ScholarlyCache {
  private readonly entries = new Map<string, Entry>();

  constructor(
    readonly maxEntries = 1000,
    private readonly now: () => number = Date.now,
  ) {
    if (!Number.isInteger(maxEntries) || maxEntries < 1) {
      throw new RangeError('maxEntries must be a positive integer');
    }
  }

  get size(): number {
    return this.entries.size;
  }

  get(key: string): Promise<string | undefined> {
    const entry = this.entries.get(key);
    if (entry === undefined) return Promise.resolve(undefined);
    if (entry.expiresAt <= this.now()) {
      this.entries.delete(key);
      return Promise.resolve(undefined);
    }
    this.entries.delete(key);
    this.entries.set(key, entry);
    return Promise.resolve(entry.value);
  }

  set(key: string, value: string, ttlMs: number): Promise<void> {
    if (!(ttlMs > 0)) return Promise.resolve();
    this.entries.delete(key);
    this.entries.set(key, { value, expiresAt: this.now() + ttlMs });
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next();
      if (oldest.done === true) break;
      this.entries.delete(oldest.value);
    }
    return Promise.resolve();
  }
}

/**
 * Cache keys are hashed so that query text (research content) is never stored in plain
 * form as a key in a shared cache such as Redis.
 */
export function cacheKey(provider: string, sanitizedUrl: string): string {
  const digest = createHash('sha256').update(sanitizedUrl).digest('hex');
  return `scholarly:v1:${provider}:${digest}`;
}
