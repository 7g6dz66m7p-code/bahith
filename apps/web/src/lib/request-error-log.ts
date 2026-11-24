/**
 * A server error as a single JSON log line, without research content: the route
 * pattern (e.g. /api/projects/[projectId]/assistant, never the concrete path with ids or
 * query), the method, the error class and Next's digest. Messages, stacks, bodies and
 * headers are never included because they can echo questions, passages or tokens.
 */
export interface RequestErrorRecord {
  level: 'error';
  event: 'request.error';
  time: string;
  route: string;
  method: string;
  routeType: string;
  error: string;
  digest: string | null;
}

const SAFE_NAME = /^[A-Za-z][A-Za-z0-9_]{0,63}$/u;

export function requestErrorRecord(
  error: unknown,
  request: { method: string },
  context: { routePath: string; routeType: string },
  now: Date = new Date(),
): RequestErrorRecord {
  const name = error instanceof Error && SAFE_NAME.test(error.name) ? error.name : 'Error';
  const digest =
    typeof error === 'object' &&
    error !== null &&
    'digest' in error &&
    typeof error.digest === 'string'
      ? error.digest.slice(0, 64)
      : null;
  return {
    level: 'error',
    event: 'request.error',
    time: now.toISOString(),
    route: /^\/[\w\-/[\].]*$/u.test(context.routePath) ? context.routePath : '[unknown]',
    method: /^[A-Z]{3,7}$/u.test(request.method) ? request.method : 'OTHER',
    routeType: SAFE_NAME.test(context.routeType) ? context.routeType : 'unknown',
    error: name,
    digest,
  };
}
