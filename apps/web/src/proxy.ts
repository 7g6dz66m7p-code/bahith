import createMiddleware from 'next-intl/middleware';

import { routing } from './i18n/routing';

// Next.js 16 "proxy" (formerly middleware): negotiates the locale and redirects
// un-prefixed paths to /ar or /en.
export default createMiddleware(routing);

export const config = {
  // Everything except API routes, Next.js internals and files with an extension.
  matcher: '/((?!api|_next|_vercel|.*\\..*).*)',
};
