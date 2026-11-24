import createMiddleware from 'next-intl/middleware';
import { NextRequest } from 'next/server';

import { routing } from './i18n/routing';
import { contentSecurityPolicy } from './server/security-headers';

const localize = createMiddleware(routing);

// Next.js 16 "proxy" (formerly middleware): negotiates the locale and redirects
// un-prefixed paths to /ar or /en.
export default function proxy(request: NextRequest) {
  const nonce = Buffer.from(crypto.randomUUID()).toString('base64');
  const policy = contentSecurityPolicy(
    nonce,
    process.env.NODE_ENV === 'development',
    process.env.BETTER_AUTH_URL?.startsWith('https://') === true,
  );
  const requestHeaders = new Headers(request.headers);
  // Overwrite client values. Next extracts this nonce while rendering framework scripts.
  requestHeaders.set('x-nonce', nonce);
  requestHeaders.set('Content-Security-Policy', policy);
  // next-intl forwards request headers in both its rewrite and passthrough responses.
  const response = localize(new NextRequest(request, { headers: requestHeaders }));
  response.headers.set('Content-Security-Policy', policy);
  return response;
}

export const config = {
  // Include dotted/unknown page URLs too: localized 404 documents need a nonce.
  matcher: '/((?!api|_next|_vercel|favicon.ico).*)',
};
