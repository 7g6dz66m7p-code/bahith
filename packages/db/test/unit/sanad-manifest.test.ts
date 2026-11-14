import { describe, expect, it } from 'vitest';

import { parseExtractionManifest } from '../../src/sanad/manifest';

export function textManifest(content = 'دليل 🧪 evidence') {
  return {
    schemaVersion: 1 as const,
    fileSha256: 'a'.repeat(64),
    mimeType: 'text/plain' as const,
    extractorVersion: 'test-extractor-v1',
    chunkerVersion: 'test-chunker-v1',
    units: [{ index: 0, page: null, kind: 'text' as const, content, direction: 'rtl' as const }],
    failures: [] as { unitIndex: number; page: number | null; code: string }[],
    chunks: [
      {
        index: 0,
        unitIndex: 0,
        charStart: 0,
        charEnd: Array.from(content).length,
        content,
        pageStart: null,
        pageEnd: null,
        tokenCount: 5,
        direction: 'rtl' as const,
      },
    ],
  };
}

function first<T>(rows: T[]): T {
  const row = rows[0];
  if (row === undefined) throw new Error('fixture missing');
  return row;
}

describe('SANAD extraction manifest boundary', () => {
  it('preserves exact Arabic/English text with code-point offsets including astral characters', () => {
    const manifest = textManifest();
    expect(parseExtractionManifest(manifest)).toEqual(manifest);
  });

  it('allows different directions for individual chunks of a mixed-language unit', () => {
    const original = textManifest('English عربي');
    expect(
      parseExtractionManifest({
        ...original,
        units: [{ ...original.units[0], direction: 'ltr' }],
        chunks: [{ ...original.chunks[0], content: 'عربي', charStart: 8, charEnd: 12 }],
      }).chunks[0]?.direction,
    ).toBe('rtl');
  });

  it('uses the extractor code-point limit rather than a smaller UTF-16 limit', () => {
    // Whitespace-heavy or symbol-rich documents can exceed the former 10M UTF-16 cap.
    const content = '🧪'.repeat(10_000_001);
    const original = textManifest('');
    const accepted = { ...original, units: [{ ...original.units[0], content }], chunks: [] };
    expect(parseExtractionManifest(accepted).units[0]?.content).toBe(content);
    expect(() =>
      parseExtractionManifest({
        ...accepted,
        units: [{ ...original.units[0], content: ' '.repeat(20_000_001) }],
      }),
    ).toThrow('SANAD_INVALID_INPUT');
  });

  it.each([
    (m: ReturnType<typeof textManifest>) => {
      first(m.chunks).content = 'invented evidence';
    },
    (m: ReturnType<typeof textManifest>) => {
      first(m.chunks).charEnd += 1;
    },
    (m: ReturnType<typeof textManifest>) => {
      first(m.chunks).unitIndex = 99;
    },
    (m: ReturnType<typeof textManifest>) => {
      first(m.chunks).index = 1;
    },
    (m: ReturnType<typeof textManifest>) => {
      first(m.chunks).tokenCount = 801;
    },
    (m: ReturnType<typeof textManifest>) => {
      m.units.push(first(m.units));
    },
    (m: ReturnType<typeof textManifest>) => {
      m.failures.push({ unitIndex: 0, page: null, code: 'FAILED' });
    },
  ])('rejects invalid provenance before persistence (%#)', (tamper) => {
    const manifest = textManifest();
    tamper(manifest);
    expect(() => parseExtractionManifest(manifest)).toThrow('SANAD_INVALID_INPUT');
  });

  it('rejects invented pages in TXT/DOCX and pages disagreeing with PDF units', () => {
    const original = textManifest();
    expect(() =>
      parseExtractionManifest({ ...original, units: [{ ...original.units[0], page: 2 }] }),
    ).toThrow('SANAD_INVALID_INPUT');
    expect(() =>
      parseExtractionManifest({
        ...original,
        mimeType: 'application/pdf',
        units: [{ ...original.units[0], kind: 'page', page: 2 }],
        chunks: [{ ...original.chunks[0], pageStart: 3, pageEnd: 3 }],
      }),
    ).toThrow('SANAD_INVALID_INPUT');
  });

  it('accepts explicit failed PDF pages with no invented text', () => {
    const manifest = textManifest();
    expect(
      parseExtractionManifest({
        ...manifest,
        mimeType: 'application/pdf',
        units: [{ index: 0, kind: 'page', page: 1, content: '', direction: 'auto' }],
        chunks: [],
        failures: [{ unitIndex: 0, page: 1, code: 'PDF_PAGE_FAILED' }],
      }).chunks,
    ).toEqual([]);
  });

  it('never embeds research content in a validation error', () => {
    expect(() => parseExtractionManifest({ secret: 'private research text' })).toThrow(
      /^SANAD_INVALID_INPUT$/,
    );
  });
});
