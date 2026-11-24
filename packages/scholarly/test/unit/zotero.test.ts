import { describe, expect, it } from 'vitest';

import { ScholarlyError } from '../../src/errors';
import type { FetchLike } from '../../src/http/client';
import { HOST_POLICIES } from '../../src/http/policies';
import { ZOTERO_PAGE_SIZE, ZoteroClient } from '../../src/providers/zotero';
import { TEST_CONFIG, testHttp } from '../helpers/fixtures';

/**
 * The Zotero Web API is not reachable from the test environment, so these responses are
 * written by hand in the shape the API documents for `format=csljson`
 * (https://www.zotero.org/support/dev/web_api/v3/basics): a `{ "items": [...] }` envelope of
 * CSL-JSON objects whose ids are "<library>/<key>". The items are synthetic.
 */
const USER_ID = '1234567';
/** A placeholder in the documented key shape (24 letters and digits); not a real key. */
const API_KEY = 'fixture'.repeat(3) + '000';

function cslItem(n: number): Record<string, unknown> {
  return {
    id: `${USER_ID}/ITEM${String(n).padStart(4, '0')}`,
    type: 'article-journal',
    title: `دراسة رقم ${n}`,
    author: [{ family: 'الباحث', given: 'سارة' }],
    issued: { 'date-parts': [['2024', 1, 15]] },
    'container-title': 'مجلة اختبارية',
  };
}

interface Recorded {
  url: URL;
  headers: Record<string, string>;
}

/** Serves pages of `total` items; records every request. */
function zoteroFetch(total: number, status = 200) {
  const requests: Recorded[] = [];
  const fetchImpl: FetchLike = (input, init) => {
    const url = new URL(input);
    requests.push({ url, headers: { ...(init.headers as Record<string, string>) } });
    if (status !== 200) {
      return Promise.resolve(new Response('Forbidden', { status }));
    }
    const start = Number(url.searchParams.get('start') ?? '0');
    const limit = Number(url.searchParams.get('limit') ?? '25');
    const items = Array.from({ length: Math.max(0, Math.min(limit, total - start)) }, (_, i) =>
      cslItem(start + i + 1),
    );
    return Promise.resolve(
      new Response(JSON.stringify({ items }), {
        status: 200,
        headers: { 'content-type': 'application/json', 'Total-Results': String(total) },
      }),
    );
  };
  return { fetchImpl, requests };
}

async function failure(promise: Promise<unknown>): Promise<ScholarlyError> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  if (!(error instanceof ScholarlyError)) throw new Error('expected ScholarlyError');
  return error;
}

describe('Zotero Web API connector', () => {
  it('reads top-level items as CSL-JSON with the key in a header, never in the URL', async () => {
    const { fetchImpl, requests } = zoteroFetch(3);
    const { http } = testHttp(fetchImpl);
    const library = await new ZoteroClient({ http, config: TEST_CONFIG }).listUserItems({
      userId: USER_ID,
      apiKey: API_KEY,
    });
    expect(library.truncated).toBe(false);
    expect(library.items).toHaveLength(3);
    expect(library.items[0]).toMatchObject({ id: `${USER_ID}/ITEM0001`, title: 'دراسة رقم 1' });

    expect(requests).toHaveLength(1);
    const [request] = requests;
    expect(request?.url.origin).toBe('https://api.zotero.org');
    expect(request?.url.pathname).toBe(`/users/${USER_ID}/items/top`);
    expect(Object.fromEntries(request?.url.searchParams ?? [])).toEqual({
      format: 'csljson',
      limit: String(ZOTERO_PAGE_SIZE),
      start: '0',
      sort: 'dateAdded',
      direction: 'asc',
    });
    expect(request?.url.href).not.toContain(API_KEY);
    expect(request?.headers).toMatchObject({
      'Zotero-API-Key': API_KEY,
      'Zotero-API-Version': '3',
    });
    // The operator's contact email is not sent to Zotero.
    expect(request?.headers['User-Agent']).toBe('BAHITH-scholarly/0.1');
  });

  it('pages through the library and stops at the item cap', async () => {
    const full = zoteroFetch(250);
    const library = await new ZoteroClient({
      http: testHttp(full.fetchImpl).http,
      config: TEST_CONFIG,
    }).listUserItems({ userId: USER_ID, apiKey: API_KEY });
    expect(library.items).toHaveLength(250);
    expect(library.truncated).toBe(false);
    expect(full.requests.map((r) => r.url.searchParams.get('start'))).toEqual(['0', '100', '200']);

    const capped = zoteroFetch(1000);
    const partial = await new ZoteroClient({
      http: testHttp(capped.fetchImpl).http,
      config: TEST_CONFIG,
    }).listUserItems({ userId: USER_ID, apiKey: API_KEY }, { maxItems: 150 });
    expect(partial.items).toHaveLength(150);
    expect(partial.truncated).toBe(true);
    expect(capped.requests).toHaveLength(2);
  });

  it('accepts a bare array page as well as the items envelope', async () => {
    const fetchImpl: FetchLike = () =>
      Promise.resolve(new Response(JSON.stringify([cslItem(1)]), { status: 200 }));
    const library = await new ZoteroClient({
      http: testHttp(fetchImpl).http,
      config: TEST_CONFIG,
    }).listUserItems({ userId: USER_ID, apiKey: API_KEY });
    expect(library.items).toHaveLength(1);
  });

  it('refuses malformed credentials before any request', async () => {
    const { fetchImpl, requests } = zoteroFetch(1);
    const client = new ZoteroClient({ http: testHttp(fetchImpl).http, config: TEST_CONFIG });
    for (const credentials of [
      { userId: 'me', apiKey: API_KEY },
      { userId: '../groups/1', apiKey: API_KEY },
      { userId: USER_ID, apiKey: 'short' },
      { userId: USER_ID, apiKey: 'has spaces and symbols!!' },
    ]) {
      const error = await failure(client.listUserItems(credentials));
      expect(error.code).toBe('SCHOLARLY_INVALID_INPUT');
    }
    expect(requests).toEqual([]);
  });

  it('a rejected key fails with the status only, without retrying or echoing the key', async () => {
    const { fetchImpl, requests } = zoteroFetch(0, 403);
    const error = await failure(
      new ZoteroClient({ http: testHttp(fetchImpl).http, config: TEST_CONFIG }).listUserItems({
        userId: USER_ID,
        apiKey: API_KEY,
      }),
    );
    expect(error).toMatchObject({ code: 'SCHOLARLY_UPSTREAM_ERROR', status: 403 });
    expect(error.provider).toBe('zotero');
    expect(error.message).not.toContain(API_KEY);
    expect(error.message).not.toContain(USER_ID);
    expect(requests).toHaveLength(1);
  });

  it('an unexpected payload is a parse error', async () => {
    const fetchImpl: FetchLike = () =>
      Promise.resolve(new Response('{"items": "nope"}', { status: 200 }));
    const error = await failure(
      new ZoteroClient({ http: testHttp(fetchImpl).http, config: TEST_CONFIG }).listUserItems({
        userId: USER_ID,
        apiKey: API_KEY,
      }),
    );
    expect(error.code).toBe('SCHOLARLY_PARSE_ERROR');
  });

  it('times out instead of hanging, after bounded retries', async () => {
    const fetchImpl: FetchLike = (_input, init) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => {
          reject(new DOMException('aborted', 'AbortError'));
        });
      });
    const { http } = testHttp(fetchImpl, { timeoutMs: 5, maxRetries: 1 });
    const error = await failure(
      new ZoteroClient({ http, config: TEST_CONFIG }).listUserItems({
        userId: USER_ID,
        apiKey: API_KEY,
      }),
    );
    expect(error.code).toBe('SCHOLARLY_TIMEOUT');
  });

  it('is rate limited per host, one request at a time', () => {
    expect(HOST_POLICIES.zotero).toMatchObject({
      host: 'api.zotero.org',
      maxConcurrent: 1,
      requiresContactEmail: false,
    });
    expect(HOST_POLICIES.zotero.ratePerSecond).toBeLessThanOrEqual(2);
  });
});
