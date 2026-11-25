import type { getRequestSession } from './session';

/** Verified emails from PLATFORM_ADMIN_EMAILS (comma-separated); empty = nobody is admin. */
function adminEmails(): Set<string> {
  return new Set(
    (process.env.PLATFORM_ADMIN_EMAILS ?? '')
      .split(',')
      .map((value) => value.trim().toLowerCase())
      .filter((value) => value !== ''),
  );
}

type Session = NonNullable<Awaited<ReturnType<typeof getRequestSession>>>;

/**
 * A platform administrator: listed by the owner in PLATFORM_ADMIN_EMAILS, with a
 * verified email AND two-factor authentication turned on (this role edits platform-wide
 * limits). There is no default administrator.
 */
export function isPlatformAdmin(session: Session | null): boolean {
  if (session === null || !session.user.emailVerified) return false;
  if (session.user.twoFactorEnabled !== true) return false;
  return adminEmails().has(session.user.email.toLowerCase());
}
