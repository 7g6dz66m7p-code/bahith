import { afterEach, describe, expect, it, vi } from 'vitest';

import { SanadError } from '@bahith/db';

import { apiError, readJsonBody, requireSameOrigin } from '@/server/api';

afterEach(() => vi.unstubAllEnvs());
describe('research API request boundary', () => {
  it('requires an explicit matching origin for cookie mutations', () => {
    vi.stubEnv('BETTER_AUTH_URL', 'https://bahith.example.test');
    expect(() => {
      requireSameOrigin(
        new Request('https://bahith.example.test/api/projects', {
          method: 'POST',
          headers: { origin: 'https://attacker.example.test' },
        }),
      );
    }).toThrow('SANAD_FORBIDDEN');
    expect(() => {
      requireSameOrigin(
        new Request('https://bahith.example.test/api/projects', {
          method: 'POST',
          headers: { origin: 'https://bahith.example.test' },
        }),
      );
    }).not.toThrow();
    expect(() => {
      requireSameOrigin(
        new Request('https://bahith.example.test/api/projects', {
          method: 'POST',
        }),
      );
    }).toThrow('SANAD_FORBIDDEN');
  });
  it('bounds actual streamed JSON bytes without trusting Content-Length', async () => {
    const request = new Request('https://example.test', {
      method: 'POST',
      body: JSON.stringify({ text: 'x'.repeat(70_000) }),
    });
    await expect(readJsonBody(request)).rejects.toMatchObject({ code: 'SANAD_INVALID_INPUT' });
    expect(
      await readJsonBody(
        new Request('https://example.test', {
          method: 'POST',
          body: JSON.stringify({ title: 'سؤال بحثي' }),
        }),
      ),
    ).toEqual({ title: 'سؤال بحثي' });
  });
  it('maps review errors to stable status codes', async () => {
    const cases = [
      ['REVIEW_NOT_FOUND', 404],
      ['REVIEW_ANCHOR_STALE', 409],
      ['REVIEW_INVALID_STATE', 409],
      ['REVIEW_ANCHOR_INVALID', 400],
    ] as const;
    for (const [code, status] of cases) {
      const response = apiError(new SanadError(code, 'quoted draft text'));
      expect(response.status, code).toBe(status);
      expect(await response.json()).toEqual({ code });
    }
  });
  it('maps library organisation errors to stable status codes', async () => {
    const cases = [
      ['LIBRARY_NOT_FOUND', 404],
      ['LIBRARY_NAME_TAKEN', 409],
      ['HIGHLIGHT_QUOTE_MISMATCH', 422],
      ['SANAD_SOURCE_MISMATCH', 400],
    ] as const;
    for (const [code, status] of cases) {
      const response = apiError(new SanadError(code, 'quoted passage text'));
      expect(response.status, code).toBe(status);
      expect(await response.json()).toEqual({ code });
    }
  });
  it('never serializes database error details or supplied research text', async () => {
    const response = apiError(new Error('private source text and SQL parameters'));
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ code: 'SERVICE_UNAVAILABLE' });
  });
});
