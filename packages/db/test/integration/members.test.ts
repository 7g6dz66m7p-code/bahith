import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { z } from 'zod';

import type { Database } from '../../src/index';
import {
  acceptInvitation,
  changeMemberRole,
  createDatabase,
  inviteMember,
  listInvitations,
  listMembers,
  MemberError,
  removeMember,
  revokeInvitation,
} from '../../src/index';
import { seedReferenceData } from '../../src/seed';

import type { WorkspaceFixture } from './fixtures';
import { seedWorkspace } from './fixtures';

describe('members: invitations, roles and leaving', () => {
  let database: Database;
  let admin: pg.Client;
  let owner: WorkspaceFixture;
  let invitee: WorkspaceFixture;
  let stranger: WorkspaceFixture;
  const ws = () => ({ userId: owner.userId, workspaceId: owner.workspaceId });
  const emailOf = async (userId: string) =>
    z
      .object({ email: z.string() })
      .parse((await admin.query('SELECT email FROM users WHERE id = $1', [userId])).rows[0]).email;

  beforeAll(async () => {
    database = createDatabase({ connectionString: inject('appUrl') });
    admin = new pg.Client({ connectionString: inject('adminUrl') });
    await admin.connect();
    await seedReferenceData(admin);
    const plan = z
      .object({ id: z.string() })
      .parse((await admin.query(`SELECT id FROM plans WHERE code = 'free'`)).rows[0]);
    owner = await seedWorkspace(database, 'MemOwner', plan.id);
    invitee = await seedWorkspace(database, 'MemInvitee', plan.id);
    stranger = await seedWorkspace(database, 'MemStranger', plan.id);
  });

  afterAll(async () => {
    await database.close();
    await admin.end();
  });

  it('invites, accepts once with the invited verified email, and lists the member', async () => {
    const email = await emailOf(invitee.userId);
    const { token, invitationId } = await inviteMember(database, ws(), {
      email: email.toUpperCase(),
      role: 'supervisor',
    });
    const stored = await admin.query('SELECT token_hash FROM workspace_invitations WHERE id = $1', [
      invitationId,
    ]);
    expect(JSON.stringify(stored.rows)).not.toContain(token.split('.')[1]);
    expect((await listInvitations(database, ws())).map((i) => i.id)).toContain(invitationId);

    // Another account cannot use the link, even when signed in.
    const strangerUser = {
      userId: stranger.userId,
      email: await emailOf(stranger.userId),
      emailVerified: true,
    };
    await expect(acceptInvitation(database, strangerUser, token)).rejects.toEqual(
      new MemberError('INVITATION_EMAIL_MISMATCH'),
    );
    const user = { userId: invitee.userId, email, emailVerified: true };
    await expect(
      acceptInvitation(database, { ...user, emailVerified: false }, token),
    ).rejects.toEqual(new MemberError('INVITATION_EMAIL_MISMATCH'));
    expect(await acceptInvitation(database, user, token)).toEqual({
      workspaceId: owner.workspaceId,
      role: 'supervisor',
    });
    // Idempotent for the same user.
    expect((await acceptInvitation(database, user, token)).role).toBe('supervisor');
    const members = await listMembers(database, ws());
    expect(members.find((m) => m.userId === invitee.userId)).toMatchObject({
      role: 'supervisor',
      email: email.toLowerCase(),
      isYou: false,
    });
    expect(await listInvitations(database, ws())).not.toContainEqual(
      expect.objectContaining({ id: invitationId }),
    );
  });

  it('refuses forged, revoked and expired tokens', async () => {
    const email = 'nobody@example.test';
    await expect(
      acceptInvitation(database, { userId: invitee.userId, email, emailVerified: true }, 'garbage'),
    ).rejects.toEqual(new MemberError('INVITATION_INVALID'));
    const forged = `${owner.workspaceId}.${'A'.repeat(43)}`;
    await expect(
      acceptInvitation(database, { userId: invitee.userId, email, emailVerified: true }, forged),
    ).rejects.toEqual(new MemberError('INVITATION_INVALID'));
    const revoked = await inviteMember(database, ws(), { email, role: 'viewer' });
    await revokeInvitation(database, ws(), revoked.invitationId);
    await expect(
      acceptInvitation(
        database,
        { userId: stranger.userId, email, emailVerified: true },
        revoked.token,
      ),
    ).rejects.toEqual(new MemberError('INVITATION_INVALID'));
    const old = await inviteMember(
      database,
      ws(),
      { email, role: 'viewer' },
      new Date('2026-01-01'),
    );
    await expect(
      acceptInvitation(
        database,
        { userId: stranger.userId, email, emailVerified: true },
        old.token,
      ),
    ).rejects.toEqual(new MemberError('INVITATION_EXPIRED'));
  });

  it('only owners invite or change roles; the last owner stays', async () => {
    const asSupervisor = { userId: invitee.userId, workspaceId: owner.workspaceId };
    await expect(
      inviteMember(database, asSupervisor, { email: 'x@example.test', role: 'editor' }),
    ).rejects.toEqual(new MemberError('MEMBER_FORBIDDEN'));
    await expect(
      inviteMember(database, ws(), { email: 'y@example.test', role: 'owner' }),
    ).rejects.toEqual(new MemberError('MEMBER_INVALID_INPUT'));
    await expect(changeMemberRole(database, ws(), owner.userId, 'editor')).rejects.toEqual(
      new MemberError('MEMBER_LAST_OWNER'),
    );
    await expect(removeMember(database, ws(), owner.userId)).rejects.toEqual(
      new MemberError('MEMBER_LAST_OWNER'),
    );
    await changeMemberRole(database, ws(), invitee.userId, 'editor');
    expect((await listMembers(database, ws())).find((m) => m.userId === invitee.userId)?.role).toBe(
      'editor',
    );
  });

  it('a member can leave; outsiders see nothing; audit holds ids only', async () => {
    const outsider = { userId: stranger.userId, workspaceId: owner.workspaceId };
    await expect(listMembers(database, outsider)).rejects.toEqual(
      new MemberError('MEMBER_FORBIDDEN'),
    );
    await removeMember(
      database,
      { userId: invitee.userId, workspaceId: owner.workspaceId },
      invitee.userId,
    );
    expect((await listMembers(database, ws())).map((m) => m.userId)).not.toContain(invitee.userId);
    const audit = await admin.query(
      `SELECT action, metadata::text AS metadata FROM audit_log
        WHERE workspace_id = $1 AND action LIKE 'member.%' ORDER BY created_at`,
      [owner.workspaceId],
    );
    expect(audit.rows.map((r: { action: string }) => r.action)).toEqual(
      expect.arrayContaining([
        'member.invited',
        'member.joined',
        'member.role_changed',
        'member.left',
      ]),
    );
    expect(JSON.stringify(audit.rows)).not.toMatch(/@/u);
  });
});
