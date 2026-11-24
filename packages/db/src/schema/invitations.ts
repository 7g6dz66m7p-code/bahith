import { sql } from 'drizzle-orm';
import { check, index, pgTable, text, timestamp, unique } from 'drizzle-orm/pg-core';

import { createdAt, id, tenantExtras } from './_shared';
import { membershipRoleEnum } from './enums';
import { userRef, workspaceIdColumn } from './identity';

/**
 * An invitation to join a workspace with a role (never owner). Only the SHA-256 of the
 * token is stored; the token itself is shown once to the inviter and sent by email. It
 * is accepted by the signed-in user whose verified email equals `email`.
 */
export const workspaceInvitations = pgTable(
  'workspace_invitations',
  {
    id: id(),
    workspaceId: workspaceIdColumn(),
    email: text('email').notNull(),
    role: membershipRoleEnum('role').notNull(),
    tokenHash: text('token_hash').notNull(),
    invitedBy: userRef('invited_by'),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    acceptedAt: timestamp('accepted_at', { withTimezone: true }),
    acceptedBy: userRef('accepted_by'),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    ...tenantExtras('workspace_invitations', t),
    unique('workspace_invitations_token_hash_key').on(t.tokenHash),
    index('workspace_invitations_workspace_email_idx').on(t.workspaceId, t.email),
    check('workspace_invitations_role_not_owner', sql`${t.role} <> 'owner'`),
    check('workspace_invitations_email_lower', sql`${t.email} = lower(${t.email})`),
    check('workspace_invitations_token_hash_format', sql`${t.tokenHash} ~ '^[0-9a-f]{64}$'`),
    check(
      'workspace_invitations_single_outcome',
      sql`not (${t.acceptedAt} is not null and ${t.revokedAt} is not null)`,
    ),
    check(
      'workspace_invitations_accepted_by',
      sql`${t.acceptedBy} is null or ${t.acceptedAt} is not null`,
    ),
  ],
);
