import { createHash, randomBytes } from 'node:crypto';

import { and, asc, eq, gt, isNull, ne, sql } from 'drizzle-orm';
import { z } from 'zod';

import type { Database, Tx } from './client';
import { auditLog, memberships, workspaceInvitations } from './schema/index';

export type MemberErrorCode =
  | 'MEMBER_FORBIDDEN'
  | 'MEMBER_INVALID_INPUT'
  | 'MEMBER_NOT_FOUND'
  | 'MEMBER_LAST_OWNER'
  | 'INVITATION_INVALID'
  | 'INVITATION_EXPIRED'
  | 'INVITATION_EMAIL_MISMATCH';

/** Codes only: no email address, token or name in messages or logs. */
export class MemberError extends Error {
  constructor(readonly code: MemberErrorCode) {
    super(code);
    this.name = 'MemberError';
  }
}

export interface WorkspaceActor {
  userId: string;
  workspaceId: string;
}

const actorSchema = z.strictObject({ userId: z.uuid(), workspaceId: z.uuid() });
const roleSchema = z.enum(['owner', 'editor', 'viewer', 'supervisor']);
const invitableRoleSchema = z.enum(['editor', 'viewer', 'supervisor']);
export type MemberRole = z.infer<typeof roleSchema>;

export const INVITATION_TTL_MS = 7 * 24 * 3600 * 1000;

const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');

async function roleOf(tx: Tx, actor: WorkspaceActor): Promise<MemberRole | null> {
  const [row] = await tx
    .select({ role: memberships.role })
    .from(memberships)
    .where(
      and(eq(memberships.workspaceId, actor.workspaceId), eq(memberships.userId, actor.userId)),
    )
    .for('share');
  return row?.role ?? null;
}

/** Runs `fn` for a member of the workspace; `ownerOnly` restricts it to owners. */
async function asMember<T>(
  database: Database,
  actor: WorkspaceActor,
  ownerOnly: boolean,
  fn: (tx: Tx, role: MemberRole) => Promise<T>,
): Promise<T> {
  const parsed = actorSchema.safeParse(actor);
  if (!parsed.success) throw new MemberError('MEMBER_INVALID_INPUT');
  return database.withWorkspace(
    parsed.data.workspaceId,
    async (tx) => {
      const role = await roleOf(tx, parsed.data);
      if (role === null || (ownerOnly && role !== 'owner'))
        throw new MemberError('MEMBER_FORBIDDEN');
      return fn(tx, role);
    },
    { userId: parsed.data.userId },
  );
}

async function audit(
  tx: Tx,
  actor: WorkspaceActor,
  action: string,
  entityType: string,
  entityId: string,
  metadata: Record<string, string | number | boolean | null> = {},
) {
  await tx.insert(auditLog).values({
    workspaceId: actor.workspaceId,
    actorUserId: actor.userId,
    action,
    entityType,
    entityId,
    metadata,
  });
}

/**
 * Creates an invitation (owner only) and returns the token once. The token starts with
 * the workspace id so acceptance can open that workspace's scope; only its SHA-256 is
 * stored. A newer invitation for the same email replaces a pending one.
 */
export async function inviteMember(
  database: Database,
  actor: WorkspaceActor,
  input: { email: string; role: string },
  now: Date = new Date(),
): Promise<{ invitationId: string; token: string; expiresAt: Date }> {
  const email = z.email().max(320).safeParse(input.email.trim().toLowerCase());
  const role = invitableRoleSchema.safeParse(input.role);
  if (!email.success || !role.success) throw new MemberError('MEMBER_INVALID_INPUT');
  return asMember(database, actor, true, async (tx) => {
    await tx
      .update(workspaceInvitations)
      .set({ revokedAt: now })
      .where(
        and(
          eq(workspaceInvitations.workspaceId, actor.workspaceId),
          eq(workspaceInvitations.email, email.data),
          isNull(workspaceInvitations.acceptedAt),
          isNull(workspaceInvitations.revokedAt),
        ),
      );
    const token = `${actor.workspaceId}.${randomBytes(32).toString('base64url')}`;
    const expiresAt = new Date(now.getTime() + INVITATION_TTL_MS);
    const [row] = await tx
      .insert(workspaceInvitations)
      .values({
        workspaceId: actor.workspaceId,
        email: email.data,
        role: role.data,
        tokenHash: hashToken(token),
        invitedBy: actor.userId,
        expiresAt,
      })
      .returning({ id: workspaceInvitations.id });
    if (row === undefined) throw new MemberError('MEMBER_INVALID_INPUT');
    await audit(tx, actor, 'member.invited', 'invitation', row.id, { role: role.data });
    return { invitationId: row.id, token, expiresAt };
  });
}

/**
 * Accepts an invitation for the signed-in user. The user's verified email must equal the
 * invited one; the token must be unused, unrevoked and unexpired. Joining is idempotent.
 */
export async function acceptInvitation(
  database: Database,
  user: { userId: string; email: string; emailVerified: boolean },
  token: string,
  now: Date = new Date(),
): Promise<{ workspaceId: string; role: MemberRole }> {
  const match = /^([0-9a-f-]{36})\.[A-Za-z0-9_-]{43}$/u.exec(token);
  const workspaceId = z.uuid().safeParse(match?.[1]);
  const userId = z.uuid().safeParse(user.userId);
  if (!workspaceId.success || !userId.success) throw new MemberError('INVITATION_INVALID');
  if (!user.emailVerified) throw new MemberError('INVITATION_EMAIL_MISMATCH');
  const actor = { userId: userId.data, workspaceId: workspaceId.data };
  return database.withWorkspace(
    actor.workspaceId,
    async (tx) => {
      const [invitation] = await tx
        .select()
        .from(workspaceInvitations)
        .where(
          and(
            eq(workspaceInvitations.workspaceId, actor.workspaceId),
            eq(workspaceInvitations.tokenHash, hashToken(token)),
          ),
        )
        .for('update');
      if (invitation === undefined || invitation.revokedAt !== null) {
        throw new MemberError('INVITATION_INVALID');
      }
      if (invitation.email !== user.email.trim().toLowerCase()) {
        throw new MemberError('INVITATION_EMAIL_MISMATCH');
      }
      if (invitation.acceptedAt !== null) {
        if (invitation.acceptedBy === actor.userId) {
          return { workspaceId: actor.workspaceId, role: invitation.role };
        }
        throw new MemberError('INVITATION_INVALID');
      }
      if (invitation.expiresAt.getTime() <= now.getTime()) {
        throw new MemberError('INVITATION_EXPIRED');
      }
      const existing = await roleOf(tx, actor);
      if (existing === null) {
        await tx.insert(memberships).values({
          workspaceId: actor.workspaceId,
          userId: actor.userId,
          role: invitation.role,
        });
      }
      await tx
        .update(workspaceInvitations)
        .set({ acceptedAt: now, acceptedBy: actor.userId })
        .where(eq(workspaceInvitations.id, invitation.id));
      await audit(tx, actor, 'member.joined', 'invitation', invitation.id, {
        role: invitation.role,
        alreadyMember: existing !== null,
      });
      return { workspaceId: actor.workspaceId, role: existing ?? invitation.role };
    },
    { userId: actor.userId },
  );
}

export interface MemberEntry {
  userId: string;
  role: MemberRole;
  /** Known from the accepted invitation; null for founding members. */
  email: string | null;
  joinedAt: Date;
  isYou: boolean;
}

/** Members of the workspace (any member may see who else is in it). */
export async function listMembers(
  database: Database,
  actor: WorkspaceActor,
): Promise<MemberEntry[]> {
  return asMember(database, actor, false, async (tx) => {
    const rows = await tx
      .select({
        userId: memberships.userId,
        role: memberships.role,
        joinedAt: memberships.createdAt,
        email: sql<string | null>`(
          select i.email from workspace_invitations i
          where i.workspace_id = ${memberships.workspaceId} and i.accepted_by = ${memberships.userId}
          order by i.accepted_at desc limit 1)`,
      })
      .from(memberships)
      .where(eq(memberships.workspaceId, actor.workspaceId))
      .orderBy(asc(memberships.createdAt));
    return rows.map((row) => ({ ...row, isYou: row.userId === actor.userId }));
  });
}

/** Pending invitations (owner only). Tokens are never returned again. */
export async function listInvitations(
  database: Database,
  actor: WorkspaceActor,
  now: Date = new Date(),
) {
  return asMember(database, actor, true, (tx) =>
    tx
      .select({
        id: workspaceInvitations.id,
        email: workspaceInvitations.email,
        role: workspaceInvitations.role,
        expiresAt: workspaceInvitations.expiresAt,
        createdAt: workspaceInvitations.createdAt,
      })
      .from(workspaceInvitations)
      .where(
        and(
          eq(workspaceInvitations.workspaceId, actor.workspaceId),
          isNull(workspaceInvitations.acceptedAt),
          isNull(workspaceInvitations.revokedAt),
          gt(workspaceInvitations.expiresAt, now),
        ),
      )
      .orderBy(asc(workspaceInvitations.createdAt)),
  );
}

export async function revokeInvitation(
  database: Database,
  actor: WorkspaceActor,
  invitationId: string,
  now: Date = new Date(),
): Promise<void> {
  if (!z.uuid().safeParse(invitationId).success) throw new MemberError('MEMBER_INVALID_INPUT');
  await asMember(database, actor, true, async (tx) => {
    const updated = await tx
      .update(workspaceInvitations)
      .set({ revokedAt: now })
      .where(
        and(
          eq(workspaceInvitations.workspaceId, actor.workspaceId),
          eq(workspaceInvitations.id, invitationId),
          isNull(workspaceInvitations.acceptedAt),
          isNull(workspaceInvitations.revokedAt),
        ),
      )
      .returning({ id: workspaceInvitations.id });
    if (updated.length === 0) throw new MemberError('MEMBER_NOT_FOUND');
    await audit(tx, actor, 'member.invitation_revoked', 'invitation', invitationId);
  });
}

async function otherOwners(tx: Tx, workspaceId: string, exceptUserId: string): Promise<number> {
  const [row] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(memberships)
    .where(
      and(
        eq(memberships.workspaceId, workspaceId),
        eq(memberships.role, 'owner'),
        ne(memberships.userId, exceptUserId),
      ),
    );
  return row?.n ?? 0;
}

/** Owner changes a member's role; the workspace always keeps at least one owner. */
export async function changeMemberRole(
  database: Database,
  actor: WorkspaceActor,
  targetUserId: string,
  role: string,
): Promise<void> {
  const target = z.uuid().safeParse(targetUserId);
  const newRole = roleSchema.safeParse(role);
  if (!target.success || !newRole.success) throw new MemberError('MEMBER_INVALID_INPUT');
  await asMember(database, actor, true, async (tx) => {
    const current = await roleOf(tx, { workspaceId: actor.workspaceId, userId: target.data });
    if (current === null) throw new MemberError('MEMBER_NOT_FOUND');
    if (current === 'owner' && newRole.data !== 'owner') {
      if ((await otherOwners(tx, actor.workspaceId, target.data)) === 0) {
        throw new MemberError('MEMBER_LAST_OWNER');
      }
    }
    await tx
      .update(memberships)
      .set({ role: newRole.data })
      .where(
        and(eq(memberships.workspaceId, actor.workspaceId), eq(memberships.userId, target.data)),
      );
    await audit(tx, actor, 'member.role_changed', 'user', target.data, {
      from: current,
      to: newRole.data,
    });
  });
}

/** Owner removes a member, or a member leaves; the last owner cannot leave. */
export async function removeMember(
  database: Database,
  actor: WorkspaceActor,
  targetUserId: string,
): Promise<void> {
  const target = z.uuid().safeParse(targetUserId);
  if (!target.success) throw new MemberError('MEMBER_INVALID_INPUT');
  const leaving = target.data === actor.userId;
  await asMember(database, actor, !leaving, async (tx) => {
    const current = await roleOf(tx, { workspaceId: actor.workspaceId, userId: target.data });
    if (current === null) throw new MemberError('MEMBER_NOT_FOUND');
    if (current === 'owner' && (await otherOwners(tx, actor.workspaceId, target.data)) === 0) {
      throw new MemberError('MEMBER_LAST_OWNER');
    }
    await tx
      .delete(memberships)
      .where(
        and(eq(memberships.workspaceId, actor.workspaceId), eq(memberships.userId, target.data)),
      );
    await audit(tx, actor, leaving ? 'member.left' : 'member.removed', 'user', target.data, {
      role: current,
    });
  });
}
