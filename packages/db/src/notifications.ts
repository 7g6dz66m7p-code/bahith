import { and, count, desc, eq, inArray, isNull, ne } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import { z } from 'zod';

import type { Database, Tx } from './client';
import type { MembershipRole } from './sanad/access';
import { SanadError } from './sanad/errors';
import { memberships, notifications, projects, workspaces } from './schema/index';
import type { notificationKindEnum } from './schema/index';

/**
 * In-app notifications.
 *
 * A notification row holds ids and a kind only; the reader's interface builds the text.
 * Rows are written by the services inside the transaction of the action they report
 * (`notify`), in a savepoint, so a failure to notify never undoes or breaks the action.
 *
 * Reading is always "my notifications": the recipient is the acting user from the
 * server session, never an id from a request. Row-level security keeps workspaces
 * apart; the recipient filter keeps members of the same workspace apart.
 */

export type NotificationKind = (typeof notificationKindEnum.enumValues)[number];
export type NotificationEntityType = 'document' | 'file' | 'user' | 'workspace';

export interface NotifyInput {
  workspaceId: string;
  kind: NotificationKind;
  entityType: NotificationEntityType;
  entityId: string;
  projectId?: string | null;
  /** These users, if they are (still) members of the workspace. */
  userIds?: readonly (string | null)[];
  /** Every member holding one of these roles. */
  roles?: readonly MembershipRole[];
  /** Never notify this user (usually the actor: nobody is told about their own action). */
  exceptUserId?: string | null;
}

/**
 * Records a notification for each recipient, inside the caller's transaction. Only
 * current members of the workspace can be recipients. Best effort: it runs in a
 * savepoint and returns 0 instead of throwing, so the surrounding action carries on.
 */
export async function notify(tx: Tx, input: NotifyInput): Promise<number> {
  const userIds = (input.userIds ?? []).filter((value): value is string => value !== null);
  const roles = input.roles ?? [];
  if (userIds.length === 0 && roles.length === 0) return 0;
  try {
    return await tx.transaction(async (savepoint) => {
      const conditions: SQL[] = [eq(memberships.workspaceId, input.workspaceId)];
      if (userIds.length > 0) conditions.push(inArray(memberships.userId, userIds));
      if (roles.length > 0) conditions.push(inArray(memberships.role, [...roles]));
      if (input.exceptUserId != null) conditions.push(ne(memberships.userId, input.exceptUserId));
      const recipients = await savepoint
        .select({ userId: memberships.userId })
        .from(memberships)
        .where(and(...conditions));
      if (recipients.length === 0) return 0;
      await savepoint.insert(notifications).values(
        recipients.map((recipient) => ({
          workspaceId: input.workspaceId,
          recipientUserId: recipient.userId,
          kind: input.kind,
          entityType: input.entityType,
          entityId: input.entityId,
          projectId: input.projectId ?? null,
        })),
      );
      return recipients.length;
    });
  } catch {
    return 0;
  }
}

export interface NotificationReader {
  /** The signed-in user (from the server session). */
  userId: string;
  /** Limit to one workspace; all of the user's workspaces when omitted. */
  workspaceId?: string;
}

export interface NotificationEntry {
  id: string;
  workspaceId: string;
  /** Looked up when read (the reader is a member); never stored in the notification. */
  workspaceName: string;
  kind: NotificationKind;
  entityType: NotificationEntityType;
  entityId: string;
  projectId: string | null;
  projectTitle: string | null;
  readAt: string | null;
  createdAt: string;
}

const readerSchema = z.strictObject({ userId: z.uuid(), workspaceId: z.uuid().optional() });
const listOptionsSchema = z.strictObject({
  unreadOnly: z.boolean().default(false),
  limit: z.number().int().min(1).max(100).default(30),
});
const idsSchema = z.array(z.uuid()).min(1).max(100);

function parseReader(reader: NotificationReader) {
  const parsed = readerSchema.safeParse(reader);
  if (!parsed.success) throw new SanadError('SANAD_INVALID_INPUT');
  return parsed.data;
}

/**
 * Runs `fn` once per workspace the user is a member of (or only `workspaceId`), each in
 * its own transaction bound to that workspace, re-checking the membership there.
 */
async function forEachWorkspace<T>(
  database: Database,
  reader: { userId: string; workspaceId?: string | undefined },
  fn: (tx: Tx, workspace: { id: string; name: string }) => Promise<T>,
): Promise<T[]> {
  const spaces = await database.withUser(reader.userId, (tx) =>
    tx
      .select({ id: workspaces.id, name: workspaces.name })
      .from(workspaces)
      .innerJoin(memberships, eq(memberships.workspaceId, workspaces.id))
      .where(
        and(
          eq(memberships.userId, reader.userId),
          ...(reader.workspaceId === undefined ? [] : [eq(workspaces.id, reader.workspaceId)]),
        ),
      )
      .orderBy(workspaces.createdAt),
  );
  const results = await Promise.all(
    spaces.map((space) =>
      database.withWorkspace(
        space.id,
        async (tx) => {
          const [member] = await tx
            .select({ role: memberships.role })
            .from(memberships)
            .where(
              and(eq(memberships.workspaceId, space.id), eq(memberships.userId, reader.userId)),
            )
            .for('share');
          return member === undefined ? null : { value: await fn(tx, space) };
        },
        { userId: reader.userId },
      ),
    ),
  );
  return results.flatMap((result) => (result === null ? [] : [result.value]));
}

const mine = (workspaceId: string, userId: string) =>
  and(eq(notifications.workspaceId, workspaceId), eq(notifications.recipientUserId, userId));

async function unreadIn(tx: Tx, workspaceId: string, userId: string): Promise<number> {
  const [row] = await tx
    .select({ n: count() })
    .from(notifications)
    .where(and(mine(workspaceId, userId), isNull(notifications.readAt)));
  return row?.n ?? 0;
}

/** The user's notifications, newest first, across their workspaces, and the unread count. */
export async function listNotifications(
  database: Database,
  reader: NotificationReader,
  options: z.input<typeof listOptionsSchema> = {},
): Promise<{ notifications: NotificationEntry[]; unreadCount: number }> {
  const actor = parseReader(reader);
  const parsed = listOptionsSchema.safeParse(options);
  if (!parsed.success) throw new SanadError('SANAD_INVALID_INPUT');
  const { unreadOnly, limit } = parsed.data;
  const perWorkspace = await forEachWorkspace(database, actor, async (tx, space) => {
    const rows = await tx
      .select({
        id: notifications.id,
        workspaceId: notifications.workspaceId,
        kind: notifications.kind,
        entityType: notifications.entityType,
        entityId: notifications.entityId,
        projectId: notifications.projectId,
        projectTitle: projects.title,
        readAt: notifications.readAt,
        createdAt: notifications.createdAt,
      })
      .from(notifications)
      .leftJoin(
        projects,
        and(
          eq(projects.workspaceId, notifications.workspaceId),
          eq(projects.id, notifications.projectId),
        ),
      )
      .where(
        and(mine(space.id, actor.userId), ...(unreadOnly ? [isNull(notifications.readAt)] : [])),
      )
      .orderBy(desc(notifications.createdAt), desc(notifications.id))
      .limit(limit);
    return {
      unread: await unreadIn(tx, space.id, actor.userId),
      rows: rows.map((row) => ({ ...row, workspaceName: space.name })),
    };
  });
  const entries = perWorkspace
    .flatMap((result) => result.rows)
    .sort((x, y) => y.createdAt.getTime() - x.createdAt.getTime())
    .slice(0, limit)
    .map((row) => ({
      ...row,
      readAt: row.readAt?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
    }));
  return {
    notifications: entries,
    unreadCount: perWorkspace.reduce((sum, result) => sum + result.unread, 0),
  };
}

/** How many of the user's notifications are unread (for the header badge). */
export async function unreadCount(database: Database, reader: NotificationReader) {
  const actor = parseReader(reader);
  const counts = await forEachWorkspace(database, actor, (tx, space) =>
    unreadIn(tx, space.id, actor.userId),
  );
  return counts.reduce((sum, n) => sum + n, 0);
}

/**
 * Marks the user's own notifications as read: the given ids, or all of them. Ids that
 * are not the user's (another member's, another workspace's, unknown) are ignored.
 * Returns how many were newly marked.
 */
export async function markNotificationsRead(
  database: Database,
  reader: NotificationReader,
  target: readonly string[] | 'all',
  now: Date = new Date(),
): Promise<number> {
  const actor = parseReader(reader);
  let ids: string[] | null = null;
  if (target !== 'all') {
    const parsed = idsSchema.safeParse(target);
    if (!parsed.success) throw new SanadError('SANAD_INVALID_INPUT');
    ids = parsed.data;
  }
  const updated = await forEachWorkspace(database, actor, async (tx, space) => {
    const rows = await tx
      .update(notifications)
      .set({ readAt: now })
      .where(
        and(
          mine(space.id, actor.userId),
          isNull(notifications.readAt),
          ...(ids === null ? [] : [inArray(notifications.id, ids)]),
        ),
      )
      .returning({ id: notifications.id });
    return rows.length;
  });
  return updated.reduce((sum, n) => sum + n, 0);
}
