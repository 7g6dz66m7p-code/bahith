import { headers } from 'next/headers';

import { redirect } from '@/i18n/navigation';

import { getAuth } from './auth';

export async function requireSession(locale: 'ar' | 'en') {
  // Read the request headers first: this marks the page as dynamic before any auth
  // configuration is needed, so a build without runtime secrets never prerenders it.
  const requestHeaders = await headers();
  const session = await getAuth()
    .api.getSession({ headers: requestHeaders })
    .catch(() => {
      // Next may log rendering failures; discard private driver/token diagnostics.
      throw new Error('AUTH_UNAVAILABLE');
    });
  if (session === null || !session.user.emailVerified) {
    redirect({ href: '/sign-in', locale });
  }
  if (session === null) throw new Error('AUTH_SESSION_REQUIRED');
  return session;
}

/** Session identity is always resolved server-side; request bodies cannot supply it. */
export async function getRequestSession(request: Request) {
  const session = await getAuth().api.getSession({ headers: request.headers });
  return session?.user.emailVerified ? session : null;
}
