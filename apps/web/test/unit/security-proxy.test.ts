import { NextRequest } from 'next/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

import proxy from '@/proxy';

afterEach(() => vi.unstubAllEnvs());

describe('nonce forwarding through locale negotiation', () => {
  it('replaces attacker-supplied nonce and CSP before the page renders', () => {
    vi.stubEnv('NODE_ENV', 'production');
    const response = proxy(
      new NextRequest('http://localhost:3000/ar', {
        headers: { 'x-nonce': 'attacker', 'content-security-policy': "script-src 'unsafe-inline'" },
      }),
    );
    const policy = response.headers.get('content-security-policy');
    expect(policy).toContain("'strict-dynamic'");
    expect(policy).not.toContain("script-src 'unsafe-inline'");
    expect(policy).not.toContain('attacker');
    expect(response.headers.get('x-middleware-request-content-security-policy')).toBe(policy);
    const nonce = response.headers.get('x-middleware-request-x-nonce');
    expect(nonce).toBeTruthy();
    expect(policy).toContain(`'nonce-${nonce}'`);
  });

  it('forwards independent nonces on repeated localized requests', () => {
    const one = proxy(new NextRequest('http://localhost:3000/en'));
    const two = proxy(new NextRequest('http://localhost:3000/en'));
    expect(one.headers.get('content-security-policy')).not.toBe(
      two.headers.get('content-security-policy'),
    );
  });
});
