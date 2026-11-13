import { sql } from 'drizzle-orm';
import {
  boolean,
  index,
  pgPolicy,
  pgTable,
  text,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { createdAt, currentUserId, currentWorkspaceId, id, updatedAt } from './_shared';
import { localeEnum, membershipRoleEnum, workspaceKindEnum } from './enums';

/**
 * Global identity table (no workspace_id, no research data).
 * The authentication tables (sessions, accounts, verifications, two-factor) are added
 * in Phase 2 together with Better Auth (ADR-0004).
 */
export const users = pgTable(
  'users',
  {
    id: id(),
    email: text('email').notNull(),
    emailVerified: boolean('email_verified').notNull().default(false),
    name: text('name').notNull(),
    image: text('image'),
    locale: localeEnum('locale').notNull().default('ar'),
    twoFactorEnabled: boolean('two_factor_enabled').notNull().default(false),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('users_email_lower_key').on(sql`lower(${t.email})`)],
);

/**
 * The tenant itself. A workspace row is visible when the transaction is bound to it,
 * or to one of its members (so a user can list their own workspaces).
 */
export const workspaces = pgTable(
  'workspaces',
  {
    id: id(),
    name: text('name').notNull(),
    kind: workspaceKindEnum('kind').notNull().default('personal'),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    pgPolicy('workspaces_select', {
      as: 'permissive',
      for: 'select',
      to: 'public',
      using: sql`${t.id} = ${currentWorkspaceId} or exists (
        select 1 from memberships m
        where m.workspace_id = ${t.id} and m.user_id = ${currentUserId}
      )`,
    }),
    pgPolicy('workspaces_insert', {
      as: 'permissive',
      for: 'insert',
      to: 'public',
      withCheck: sql`${t.id} = ${currentWorkspaceId}`,
    }),
    pgPolicy('workspaces_update', {
      as: 'permissive',
      for: 'update',
      to: 'public',
      using: sql`${t.id} = ${currentWorkspaceId}`,
      withCheck: sql`${t.id} = ${currentWorkspaceId}`,
    }),
    pgPolicy('workspaces_delete', {
      as: 'permissive',
      for: 'delete',
      to: 'public',
      using: sql`${t.id} = ${currentWorkspaceId}`,
    }),
  ],
);

/**
 * Who belongs to which workspace, and with which role. A membership row is readable
 * inside its workspace, or by the member it belongs to; it is writable only inside
 * its workspace.
 */
export const memberships = pgTable(
  'memberships',
  {
    id: id(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: membershipRoleEnum('role').notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique('memberships_workspace_id_id_key').on(t.workspaceId, t.id),
    unique('memberships_workspace_id_user_id_key').on(t.workspaceId, t.userId),
    index('memberships_user_id_idx').on(t.userId),
    pgPolicy('memberships_select', {
      as: 'permissive',
      for: 'select',
      to: 'public',
      using: sql`${t.workspaceId} = ${currentWorkspaceId} or ${t.userId} = ${currentUserId}`,
    }),
    pgPolicy('memberships_insert', {
      as: 'permissive',
      for: 'insert',
      to: 'public',
      withCheck: sql`${t.workspaceId} = ${currentWorkspaceId}`,
    }),
    pgPolicy('memberships_update', {
      as: 'permissive',
      for: 'update',
      to: 'public',
      using: sql`${t.workspaceId} = ${currentWorkspaceId}`,
      withCheck: sql`${t.workspaceId} = ${currentWorkspaceId}`,
    }),
    pgPolicy('memberships_delete', {
      as: 'permissive',
      for: 'delete',
      to: 'public',
      using: sql`${t.workspaceId} = ${currentWorkspaceId}`,
    }),
  ],
);

/** `workspace_id` column of a tenant table. Deleting a workspace deletes its data. */
export const workspaceIdColumn = () =>
  uuid('workspace_id')
    .notNull()
    .references(() => workspaces.id, { onDelete: 'cascade' });

/** Nullable reference to the acting user; kept (as NULL) when the user is deleted. */
export const userRef = (name: string) =>
  uuid(name).references(() => users.id, { onDelete: 'set null' });
