import { z } from 'zod';

import { ScholarlyError } from '../errors';
import type { CallOptions, ProviderContext } from './common';

const BASE_URL = 'https://api.zotero.org';
const PROVIDER = 'zotero';

/** Largest page the Zotero Web API serves. */
export const ZOTERO_PAGE_SIZE = 100;
/** Most items one import reads (20 pages); the rest is reported as truncated. */
export const ZOTERO_MAX_ITEMS = 2_000;

/**
 * A user's own library credentials, entered for one import and never stored. The key is
 * sent only in the `Zotero-API-Key` header (never in the URL), and it never appears in
 * errors: those carry the provider and HTTP status only.
 */
export interface ZoteroCredentials {
  /** The numeric user ID shown at zotero.org/settings/keys. */
  userId: string;
  apiKey: string;
}

export const zoteroCredentialsSchema = z.strictObject({
  userId: z
    .string()
    .trim()
    .regex(/^\d{1,12}$/u),
  apiKey: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9]{16,64}$/u),
});

const itemSchema = z.record(z.string(), z.unknown());
/** `format=csljson` answers `{ "items": [...] }`; a bare array is accepted too. */
const pageSchema = z.union([z.object({ items: z.array(itemSchema) }), z.array(itemSchema)]);

export interface ZoteroLibrary {
  /** Raw CSL-JSON objects as Zotero sent them: untrusted, validate before use. */
  items: Record<string, unknown>[];
  /** True when the library has more than `maxItems` top-level items. */
  truncated: boolean;
}

/**
 * Zotero Web API v3 (https://www.zotero.org/support/dev/web_api/v3/basics): reads the
 * top-level items of a user library as CSL-JSON, page by page, through the shared HTTP
 * core (per-host rate limit, timeout, bounded retries honouring Retry-After).
 *
 * Responses are never cached: they are private to the key holder, and the cache key is
 * the URL, which does not include the key.
 */
export class ZoteroClient {
  constructor(private readonly ctx: ProviderContext) {}

  async listUserItems(
    credentials: ZoteroCredentials,
    options: CallOptions & { maxItems?: number } = {},
  ): Promise<ZoteroLibrary> {
    const parsed = zoteroCredentialsSchema.safeParse(credentials);
    const maxItems = options.maxItems ?? ZOTERO_MAX_ITEMS;
    if (!parsed.success || !Number.isInteger(maxItems) || maxItems < 1) {
      throw new ScholarlyError('SCHOLARLY_INVALID_INPUT', { provider: PROVIDER });
    }
    const { userId, apiKey } = parsed.data;
    const headers = {
      Accept: 'application/json',
      'User-Agent': `${this.ctx.config.appName}-scholarly/0.1`,
      'Zotero-API-Version': '3',
      'Zotero-API-Key': apiKey,
    };
    const items: Record<string, unknown>[] = [];
    for (let start = 0; ; start += ZOTERO_PAGE_SIZE) {
      const url = new URL(`/users/${userId}/items/top`, BASE_URL);
      url.searchParams.set('format', 'csljson');
      url.searchParams.set('limit', String(ZOTERO_PAGE_SIZE));
      url.searchParams.set('start', String(start));
      // A fixed order keeps pages stable while the library is read.
      url.searchParams.set('sort', 'dateAdded');
      url.searchParams.set('direction', 'asc');
      const { data } = await this.ctx.http.getJson(
        {
          provider: PROVIDER,
          url,
          headers,
          ...(options.signal === undefined ? {} : { signal: options.signal }),
        },
        pageSchema,
      );
      const page = Array.isArray(data) ? data : data.items;
      items.push(...page);
      if (page.length < ZOTERO_PAGE_SIZE) return { items, truncated: false };
      if (items.length >= maxItems) {
        return { items: items.slice(0, maxItems), truncated: true };
      }
    }
  }
}
