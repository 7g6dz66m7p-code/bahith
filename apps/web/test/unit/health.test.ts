import { describe, expect, it } from 'vitest';

import { checkHealth } from '@/lib/health';

describe('checkHealth', () => {
  it('reports ok when every dependency answers', async () => {
    const report = await checkHealth({
      database: () => Promise.resolve(1),
      redis: () => Promise.resolve('PONG'),
    });
    expect(report).toEqual({ status: 'ok', checks: { database: 'up', redis: 'up' } });
  });

  it('reports degraded and names the failing dependency only', async () => {
    const report = await checkHealth({
      database: () => Promise.reject(new Error('password authentication failed for user "x"')),
      redis: () => Promise.resolve('PONG'),
    });
    expect(report).toEqual({ status: 'degraded', checks: { database: 'down', redis: 'up' } });
    // No error text may leak into the public report.
    expect(JSON.stringify(report)).not.toContain('password');
  });

  it('treats a dependency that does not answer in time as down', async () => {
    const report = await checkHealth(
      {
        database: () => new Promise(() => undefined),
        redis: () => Promise.resolve('PONG'),
      },
      20,
    );
    expect(report).toEqual({ status: 'degraded', checks: { database: 'down', redis: 'up' } });
  });

  it('treats a probe that throws synchronously as down', async () => {
    const report = await checkHealth({
      database: () => {
        throw new Error('not configured');
      },
    });
    expect(report).toEqual({ status: 'degraded', checks: { database: 'down' } });
  });
});
