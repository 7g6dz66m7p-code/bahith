import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { isPagedMimeType, parseExtractionManifest } from '../../src/sanad/manifest';

/**
 * Cross-language contract: this manifest was written by the Python worker
 * (`extract_document` on apps/worker/tests/fixtures/ocr/arabic-page.png, real Tesseract
 * OCR). The TypeScript boundary must accept it unchanged.
 */
const fixture = JSON.parse(
  readFileSync(path.join(import.meta.dirname, '../fixtures/manifest-ocr-image-v1.json'), 'utf8'),
) as Record<string, unknown>;

describe('extraction manifest contract (Python → TypeScript)', () => {
  it('accepts an OCR manifest produced by the worker', () => {
    const manifest = parseExtractionManifest(fixture);
    expect(manifest.mimeType).toBe('image/png');
    expect(manifest.units).toHaveLength(1);
    expect(manifest.units[0]).toMatchObject({ page: 1, kind: 'page', method: 'ocr' });
    expect(manifest.units[0]?.content).toContain('المصادر الأصلية');
    expect(manifest.chunks[0]?.pageStart).toBe(1);
  });

  it('rejects OCR text that claims to come from a non-paged format', () => {
    const units = fixture.units as Record<string, unknown>[];
    expect(() =>
      parseExtractionManifest({
        ...fixture,
        mimeType: 'text/plain',
        units: units.map((unit) => ({ ...unit, page: null, kind: 'text' })),
        chunks: [],
      }),
    ).toThrow();
  });

  it('rejects image text that is not labelled as OCR', () => {
    const units = fixture.units as Record<string, unknown>[];
    expect(() =>
      parseExtractionManifest({
        ...fixture,
        units: units.map((unit) => ({ ...unit, method: 'text', ocrConfidence: null })),
      }),
    ).toThrow();
  });

  it('treats PDFs and images as paged formats only', () => {
    expect(isPagedMimeType('application/pdf')).toBe(true);
    expect(isPagedMimeType('image/tiff')).toBe(true);
    expect(isPagedMimeType('text/plain')).toBe(false);
  });
});
