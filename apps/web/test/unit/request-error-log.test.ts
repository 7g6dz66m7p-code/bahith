import { describe, expect, it } from 'vitest';

import { requestErrorRecord } from '../../src/lib/request-error-log';

describe('request error log', () => {
  it('keeps the route pattern, method, error class and digest — never the message', () => {
    const error = Object.assign(new TypeError('سؤال الباحث: ما أثر التعلم المدمج؟ token=abc'), {
      digest: '12345',
    });
    const record = requestErrorRecord(
      error,
      { method: 'POST' },
      { routePath: '/api/projects/[projectId]/assistant', routeType: 'route' },
      new Date('2026-11-24T00:00:00Z'),
    );
    expect(record).toEqual({
      level: 'error',
      event: 'request.error',
      time: '2026-11-24T00:00:00.000Z',
      route: '/api/projects/[projectId]/assistant',
      method: 'POST',
      routeType: 'route',
      error: 'TypeError',
      digest: '12345',
    });
    expect(JSON.stringify(record)).not.toMatch(/سؤال|token/u);
  });

  it('refuses unexpected shapes instead of echoing them', () => {
    const odd = new Error('x');
    odd.name = 'Bad name with text';
    const record = requestErrorRecord(
      odd,
      { method: 'post; drop' },
      { routePath: '/a?q=secret', routeType: '<x>' },
    );
    expect(record).toMatchObject({
      error: 'Error',
      method: 'OTHER',
      route: '[unknown]',
      routeType: 'unknown',
    });
  });
});
