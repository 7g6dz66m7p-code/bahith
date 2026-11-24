import { detectInterchangeFormat } from '@bahith/citations';
import { ScholarlyError } from '@bahith/scholarly';
import { describe, expect, it } from 'vitest';

import { cslToRecord } from '@/server/scholarly';
import { cslItemsFromZotero, zoteroFailure } from '@/server/zotero';

/**
 * Items in the shape the Zotero Web API returns for `format=csljson` (hand-written: the
 * API is not reachable from tests). Synthetic records, not real publications.
 */
const ZOTERO_ITEMS: Record<string, unknown>[] = [
  {
    id: '1234567/ABCD2345',
    type: 'article-journal',
    title: 'أثر التعلم المدمج في التحصيل',
    'container-title': 'مجلة العلوم التربوية',
    author: [{ family: 'الأحمد', given: 'سارة' }, { literal: 'فريق البحث' }],
    issued: { 'date-parts': [['2024', 3]] },
    volume: 12,
    page: '45-67',
    DOI: '10.5555/EXAMPLE.2024.3',
    URL: 'https://example.org/article',
    source: 'Zotero',
  },
  { id: '1234567/NOTE0001', type: 'document', note: 'a standalone note has no title' },
  { id: '1234567/BAD00001', type: 'book', title: 'Bad', issued: { 'date-parts': [['x']] } },
  {
    id: '1234567/WEB00001',
    type: 'webpage',
    title: 'A page',
    URL: 'javascript:alert(1)',
  },
];

describe('Zotero import mapping', () => {
  it('maps Zotero CSL-JSON to stored source records', () => {
    const { items, invalid } = cslItemsFromZotero({ items: ZOTERO_ITEMS, truncated: false });
    // The malformed date is counted, not fatal.
    expect(invalid).toBe(1);
    const records = items.map((item) => cslToRecord(item));
    expect(records[0]).toMatchObject({
      type: 'article-journal',
      title: 'أثر التعلم المدمج في التحصيل',
      authors: [{ family: 'الأحمد', given: 'سارة' }, { literal: 'فريق البحث' }],
      year: 2024,
      containerTitle: 'مجلة العلوم التربوية',
      volume: '12',
      pages: '45-67',
      doi: '10.5555/example.2024.3',
      url: 'https://example.org/article',
    });
    // A note (no title) is skipped by the importer.
    expect(records[1]).toBeNull();
    // Only http(s) links are kept.
    expect(records[2]).toMatchObject({ title: 'A page', url: null });
  });

  it('an empty library imports nothing', () => {
    expect(cslItemsFromZotero({ items: [], truncated: false })).toEqual({ items: [], invalid: 0 });
  });

  it('a Zotero CSL-JSON export file is detected as CSL-JSON', () => {
    expect(detectInterchangeFormat(JSON.stringify(ZOTERO_ITEMS))).toBe('csl-json');
  });

  it('maps failures to stable codes without credentials', () => {
    const cases: [unknown, { status: number; code: string } | null][] = [
      [
        new ScholarlyError('SCHOLARLY_UPSTREAM_ERROR', { provider: 'zotero', status: 403 }),
        { status: 422, code: 'ZOTERO_KEY_REJECTED' },
      ],
      [
        new ScholarlyError('SCHOLARLY_UPSTREAM_ERROR', { provider: 'zotero', status: 401 }),
        { status: 422, code: 'ZOTERO_KEY_REJECTED' },
      ],
      [
        new ScholarlyError('SCHOLARLY_NOT_FOUND', { provider: 'zotero', status: 404 }),
        { status: 422, code: 'ZOTERO_LIBRARY_NOT_FOUND' },
      ],
      [
        new ScholarlyError('SCHOLARLY_RATE_LIMITED', { provider: 'zotero', status: 429 }),
        { status: 503, code: 'ZOTERO_RATE_LIMITED' },
      ],
      [
        new ScholarlyError('SCHOLARLY_TIMEOUT', { provider: 'zotero' }),
        { status: 504, code: 'ZOTERO_TIMEOUT' },
      ],
      [
        new DOMException('The operation timed out.', 'TimeoutError'),
        { status: 504, code: 'ZOTERO_TIMEOUT' },
      ],
      [
        new ScholarlyError('SCHOLARLY_UPSTREAM_ERROR', { provider: 'zotero', status: 500 }),
        { status: 503, code: 'ZOTERO_UNAVAILABLE' },
      ],
      [
        new ScholarlyError('SCHOLARLY_PARSE_ERROR', { provider: 'zotero' }),
        { status: 503, code: 'ZOTERO_UNAVAILABLE' },
      ],
      [
        new ScholarlyError('SCHOLARLY_INVALID_INPUT', { provider: 'zotero' }),
        { status: 400, code: 'ZOTERO_INVALID_CREDENTIALS' },
      ],
      [new Error('something else'), null],
    ];
    for (const [error, expected] of cases) {
      expect(zoteroFailure(error)).toEqual(expected);
    }
  });
});
