import { sql } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import { customType, pgPolicy, timestamp, unique, uuid } from 'drizzle-orm/pg-core';

/** Name of the database role the application connects as. It has no BYPASSRLS. */
export const APP_ROLE = 'bahith_app';
/** Private identity runtime: no access to research tables. */
export const AUTH_ROLE = 'bahith_auth';
/** Trigger owner with only the INSERT grants needed for first-workspace provisioning. */
export const IDENTITY_PROVISIONER_ROLE = 'bahith_identity_provisioner';

/** Fixed dimension of `chunks.embedding` (see ADR-0002). */
export const EMBEDDING_DIMENSIONS = 1024;

/**
 * The workspace bound to the current transaction by `withWorkspace`.
 * Evaluates to NULL when no workspace is bound, so every tenant policy fails closed.
 */
export const currentWorkspaceId = sql`nullif(current_setting('app.workspace_id', true), '')::uuid`;

/** The user bound to the current transaction by `withUser` / `withWorkspace`. */
export const currentUserId = sql`nullif(current_setting('app.user_id', true), '')::uuid`;

export const id = () => uuid('id').primaryKey().defaultRandom();

export const createdAt = () =>
  timestamp('created_at', { withTimezone: true }).notNull().defaultNow();

export const updatedAt = () =>
  timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date());

/**
 * Row-level-security policy shared by every tenant table: a row is visible and
 * writable only inside a transaction bound to its own workspace.
 */
export const tenantPolicy = (table: string) =>
  pgPolicy(`${table}_tenant_isolation`, {
    as: 'permissive',
    for: 'all',
    to: 'public',
    using: sql`workspace_id = ${currentWorkspaceId}`,
    withCheck: sql`workspace_id = ${currentWorkspaceId}`,
  });

/**
 * Constraints every tenant table carries:
 *  - UNIQUE (workspace_id, id): the target of composite foreign keys, so a child row
 *    can never point at a parent in another workspace (FK checks bypass RLS);
 *  - the tenant isolation policy.
 */
export const tenantExtras = (table: string, t: { workspaceId: AnyPgColumn; id: AnyPgColumn }) => [
  unique(`${table}_workspace_id_id_key`).on(t.workspaceId, t.id),
  tenantPolicy(table),
];

export const tsvector = customType<{ data: string }>({
  dataType() {
    return 'tsvector';
  },
});
