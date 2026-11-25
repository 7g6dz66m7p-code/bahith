import { toNextJsHandler } from 'better-auth/next-js';

import { getAuth } from '@/server/auth';

export const runtime = 'nodejs';

async function handle(request: Request) {
  try {
    const handler = toNextJsHandler(getAuth());
    return request.method === 'GET' ? await handler.GET(request) : await handler.POST(request);
  } catch {
    // Driver errors can contain query values, including identity tokens.
    return Response.json({ code: 'AUTH_UNAVAILABLE' }, { status: 503 });
  }
}

export const GET = handle;
export const POST = handle;
