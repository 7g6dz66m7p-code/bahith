import { APIError } from 'better-auth/api';

/** Better Auth's built-in TOTP challenge does not cover these social sign-in paths. */
export function isSocialSessionPath(path: string | undefined): boolean {
  return (
    path === '/sign-in/social' ||
    /^\/callback\/[^/]+$/u.test(path ?? '') ||
    /^\/oauth2\/callback\/[^/]+$/u.test(path ?? '')
  );
}

/** Reject rather than create a session that bypasses this account's local second factor. */
export async function enforceSocialSecondFactor(
  path: string | undefined,
  userId: string,
  hasLocalSecondFactor: (userId: string) => Promise<boolean>,
): Promise<void> {
  if (isSocialSessionPath(path) && (await hasLocalSecondFactor(userId))) {
    throw new APIError('FORBIDDEN', {
      code: 'AUTH_OAUTH_2FA_REQUIRED',
      message: 'Sign in with your password and second factor for this account.',
    });
  }
}
