import type { BahithAuth, BahithAuthService } from '@bahith/auth';
import { createBahithAuth, parseAuthConfig } from '@bahith/auth';

const holder = globalThis as typeof globalThis & { __bahithAuth?: BahithAuthService };

/** Lazy construction keeps build-time rendering independent of private credentials. */
export function getAuth(): BahithAuth {
  holder.__bahithAuth ??= createBahithAuth(parseAuthConfig(process.env));
  return holder.__bahithAuth.auth;
}

/** Exposes capability only; provider secrets never enter a client component. */
export function isGoogleAuthEnabled(): boolean {
  return Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
}
