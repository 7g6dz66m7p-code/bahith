import { sql } from 'drizzle-orm';
import { check, foreignKey, index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

import { createdAt, id, tenantExtras } from './_shared';
import { notificationKindEnum } from './enums';
import { memberships, workspaceIdColumn } from './identity';
import { projects } from './projects';

/**
 * In-app notifications. A row holds ids and a kind only — never research text, titles,
 * names or email addresses — so nothing private is copied out of its own table.
 *
 * Tenant RLS applies like everywhere else; on top of it the service only ever reads
 * the rows whose recipient is the acting user (members cannot read each other's).
 * The recipient is a membership: removing a member removes their notifications, and a
 * deleted project takes its notifications with it.
 */
export const notifications = pgTable(
  'notifications',
  {
    id: id(),
    workspaceId: workspaceIdColumn(),
    recipientUserId: uuid('recipient_user_id').notNull(),
    kind: notificationKindEnum('kind').notNull(),
    entityType: text('entity_type').$type<'document' | 'file' | 'user' | 'workspace'>().notNull(),
    entityId: uuid('entity_id').notNull(),
    projectId: uuid('project_id'),
    readAt: timestamp('read_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    ...tenantExtras('notifications', t),
    index('notifications_recipient_idx').on(t.workspaceId, t.recipientUserId, t.createdAt),
    foreignKey({
      name: 'notifications_recipient_membership_fk',
      columns: [t.workspaceId, t.recipientUserId],
      foreignColumns: [memberships.workspaceId, memberships.userId],
    }).onDelete('cascade'),
    foreignKey({
      name: 'notifications_project_fk',
      columns: [t.workspaceId, t.projectId],
      foreignColumns: [projects.workspaceId, projects.id],
    }).onDelete('cascade'),
    check(
      'notifications_entity_type',
      sql`${t.entityType} in ('document', 'file', 'user', 'workspace')`,
    ),
  ],
);
