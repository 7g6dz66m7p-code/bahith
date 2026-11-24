import { describe, expect, it } from 'vitest';

import { baselineSecurityHeaders, contentSecurityPolicy } from '@/server/security-headers';

describe('browser security policy', () => {
  it('permits nonce-bearing framework scripts without production eval or inline script', () => {
    const policy = contentSecurityPolicy('test-nonce', false, true);
    const script = policy.split('; ').find((directive) => directive.startsWith('script-src '));
    expect(script).toBe("script-src 'self' 'nonce-test-nonce' 'strict-dynamic'");
    expect(policy).not.toContain('unsafe-eval');
    expect(policy).toContain("object-src 'none'");
    expect(policy).toContain("frame-ancestors 'none'");
    expect(policy).toContain("base-uri 'none'");
    expect(policy).toContain('upgrade-insecure-requests');
  });

  it('keeps development tooling allowances out of the production policy', () => {
    const dev = contentSecurityPolicy('nonce', true, false);
    expect(dev).toContain("'unsafe-eval'");
    expect(dev).toContain("connect-src 'self' ws: wss:");
    expect(dev).not.toContain('upgrade-insecure-requests');
    expect(contentSecurityPolicy('nonce', false, false)).not.toContain('ws:');
  });

  it('protects all response types and sends HSTS only for configured HTTPS', () => {
    const headers = Object.fromEntries(
      baselineSecurityHeaders(true).map(({ key, value }) => [key, value]),
    );
    expect(headers['X-Content-Type-Options']).toBe('nosniff');
    expect(headers['X-Frame-Options']).toBe('DENY');
    expect(headers['Referrer-Policy']).toBe('no-referrer');
    expect(headers['Strict-Transport-Security']).toBe('max-age=31536000');
    expect(
      baselineSecurityHeaders(false).some(({ key }) => key === 'Strict-Transport-Security'),
    ).toBe(false);
  });
});
