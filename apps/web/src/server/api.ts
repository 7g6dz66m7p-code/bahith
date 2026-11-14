import { AuthConfigError } from '@bahith/auth';
import { SanadError } from '@bahith/db';

/** Same-origin cookie mutations require an explicit matching origin. */
export function requireSameOrigin(request: Request): void {
  const configured = process.env.BETTER_AUTH_URL;
  const origin = request.headers.get('origin');
  if (configured === undefined || origin !== new URL(configured).origin) {
    throw new SanadError('SANAD_FORBIDDEN');
  }
}

export async function readJsonBody(request: Request): Promise<unknown> {
  const limit = 64 * 1024;
  const reader = request.body?.getReader();
  if (reader === undefined) throw new SanadError('SANAD_INVALID_INPUT');
  const pieces: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      length += next.value.byteLength;
      if (length > limit) throw new SanadError('SANAD_INVALID_INPUT');
      pieces.push(next.value);
    }
    return JSON.parse(Buffer.concat(pieces).toString('utf8')) as unknown;
  } catch {
    await reader.cancel();
    throw new SanadError('SANAD_INVALID_INPUT');
  }
}

export function apiError(error: unknown): Response {
  if (error instanceof SanadError) {
    return Response.json(
      { code: error.code },
      {
        status:
          error.code === 'SANAD_FORBIDDEN'
            ? 403
            : error.code === 'SANAD_PROJECT_NOT_FOUND'
              ? 404
              : 400,
      },
    );
  }
  return Response.json(
    { code: error instanceof AuthConfigError ? 'AUTH_UNAVAILABLE' : 'SERVICE_UNAVAILABLE' },
    { status: 503 },
  );
}
