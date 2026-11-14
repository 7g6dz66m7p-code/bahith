import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  index,
  integer,
  pgPolicy,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';

import { createdAt, id, updatedAt } from './_shared';
import { users } from './identity';

/** Identity secrets are accessible only to the dedicated authentication connection. */
const authPolicy = (table: string) =>
  pgPolicy(`${table}_auth_only`, {
    as: 'permissive',
    for: 'all',
    to: 'public',
    using: sql`current_user = 'bahith_auth'`,
    withCheck: sql`current_user = 'bahith_auth'`,
  });

const authUserId = () =>
  uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' });

/** Better Auth 1.7.23 sessions. Tokens and request metadata never reach bahith_app. */
export const sessions = pgTable(
  'sessions',
  {
    id: id(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    token: text('token').notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),
    userId: authUserId(),
  },
  (t) => [
    unique('sessions_token_key').on(t.token),
    index('sessions_user_id_idx').on(t.userId),
    authPolicy('sessions'),
  ],
);

/** Credential hashes and OAuth credentials remain in the private identity boundary. */
export const accounts = pgTable(
  'accounts',
  {
    id: id(),
    accountId: text('account_id').notNull(),
    providerId: text('provider_id').notNull(),
    userId: authUserId(),
    accessToken: text('access_token'),
    refreshToken: text('refresh_token'),
    idToken: text('id_token'),
    accessTokenExpiresAt: timestamp('access_token_expires_at', { withTimezone: true }),
    refreshTokenExpiresAt: timestamp('refresh_token_expires_at', { withTimezone: true }),
    scope: text('scope'),
    password: text('password'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique('accounts_provider_account_key').on(t.providerId, t.accountId),
    index('accounts_user_id_idx').on(t.userId),
    authPolicy('accounts'),
  ],
);

export const verifications = pgTable(
  'verifications',
  {
    id: id(),
    identifier: text('identifier').notNull(),
    value: text('value').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('verifications_identifier_idx').on(t.identifier), authPolicy('verifications')],
);

/** Better Auth encrypts the TOTP secret and recovery-code material before storage. */
export const twoFactors = pgTable(
  'two_factors',
  {
    id: id(),
    secret: text('secret').notNull(),
    backupCodes: text('backup_codes').notNull(),
    userId: authUserId(),
    verified: boolean('verified').notNull().default(true),
    failedVerificationCount: integer('failed_verification_count').notNull().default(0),
    lockedUntil: timestamp('locked_until', { withTimezone: true }),
  },
  (t) => [
    unique('two_factors_user_id_key').on(t.userId),
    index('two_factors_secret_idx').on(t.secret),
    authPolicy('two_factors'),
  ],
);

/** Shared database rate limits, never available to the application role. */
export const authRateLimits = pgTable(
  'auth_rate_limits',
  {
    id: id(),
    key: text('key').notNull(),
    count: integer('count').notNull(),
    lastRequest: bigint('last_request', { mode: 'number' }).notNull(),
  },
  (t) => [unique('auth_rate_limits_key_key').on(t.key), authPolicy('auth_rate_limits')],
);

/** Drizzle adapter aliases: default Better Auth model names, snake-case SQL storage. */
export const authSchema = {
  user: users,
  session: sessions,
  account: accounts,
  verification: verifications,
  twoFactor: twoFactors,
  rateLimit: authRateLimits,
};
