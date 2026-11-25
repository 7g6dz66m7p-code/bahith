import { createHash } from 'node:crypto';

import { sql } from 'drizzle-orm';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { z } from 'zod';

import type { Database } from '../../src/client';
import { createDatabase } from '../../src/client';
import { createDocument, saveDocument } from '../../src/documents';
import { markFileFailed } from '../../src/library';
import { acceptInvitation, changeMemberRole, inviteMember, removeMember } from '../../src/members';
import type { NotificationKind } from '../../src/notifications';
import {
  listNotifications,
  markNotificationsRead,
  notify,
  unreadCount,
} from '../../src/notifications';
import { acceptSuggestion, addComment, addSuggestion, rejectSuggestion } from '../../src/review';
import { ingestExtraction } from '../../src/sanad/ingest';
import * as schema from '../../src/schema/index';
import { seedReferenceData } from '../../src/seed';

import type { WorkspaceFixture } from './fixtures';
import { seedWorkspace } from './fixtures';

const SENTENCE = 'تعتمد الدراسة على المنهج الوصفي في تحليل البيانات';
const draft = (text: string) => ({
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
});
/** The anchor of `quote` in a one-paragraph draft (its text starts at position 1). */
const anchorOf = (quote: string, versionNumber = 2) => {
  const offset = SENTENCE.indexOf(quote);
  return { versionNumber, from: 1 + offset, to: 1 + offset + quote.length, quote };
};

function manifestFor(content: string) {
  return {
    schemaVersion: 1,
    fileSha256: createHash('sha256').update(content).digest('hex'),
    mimeType: 'text/plain',
    extractorVersion: 'fixture-v1',
    chunkerVersion: 'fixture-v1',
    units: [{ index: 0, page: null, kind: 'text', content, direction: 'rtl' }],
    failures: [],
    chunks:
      content === ''
        ? []
        : [
            {
              index: 0,
              unitIndex: 0,
              charStart: 0,
              charEnd: Array.from(content).length,
              content,
              pageStart: null,
              pageEnd: null,
              tokenCount: 5,
              direction: 'rtl',
            },
          ],
  };
}

type Role = 'editor' | 'viewer' | 'supervisor';

describe('notifications', () => {
  let database: Database;
  let admin: pg.Client;
  let planId: string;
  let owner: WorkspaceFixture;
  let outsider: WorkspaceFixture;
  const members: Record<Role, string> = { editor: '', viewer: '', supervisor: '' };

  const ctx = (userId: string) => ({
    userId,
    workspaceId: owner.workspaceId,
    projectId: owner.projectId,
    userName: 'مراجع',
  });
  const reader = (userId: string) => ({ userId });

  /** The user's notifications (all workspaces) about one entity, as [kind, workspace]. */
  async function about(userId: string, entityId: string) {
    const { notifications } = await listNotifications(database, reader(userId), { limit: 100 });
    return notifications
      .filter((entry) => entry.entityId === entityId)
      .map((entry) => [entry.kind, entry.workspaceId] as [NotificationKind, string]);
  }

  async function registerFile(uploadedBy: string) {
    const [row] = await database.withWorkspace(owner.workspaceId, (tx) =>
      tx
        .insert(schema.files)
        .values({
          workspaceId: owner.workspaceId,
          sourceId: owner.sourceId,
          storageKey: `${owner.workspaceId}/${crypto.randomUUID()}`,
          originalName: 'fixture.txt',
          mimeType: 'text/plain',
          sizeBytes: 100,
          status: 'processing',
          uploadedBy,
        })
        .returning({ id: schema.files.id }),
    );
    if (row === undefined) throw new Error('fixture file missing');
    return row.id;
  }

  async function draftWithSentence(): Promise<string> {
    const { id } = await createDocument(database, ctx(owner.userId), { title: 'مسودة' });
    await saveDocument(database, ctx(owner.userId), id, {
      content: draft(SENTENCE),
      baseVersion: 1,
    });
    return id;
  }

  const emailOf = async (userId: string) =>
    z
      .object({ email: z.string() })
      .parse((await admin.query('SELECT email FROM users WHERE id = $1', [userId])).rows[0]).email;

  beforeAll(async () => {
    database = createDatabase({ connectionString: inject('appUrl') });
    admin = new pg.Client({ connectionString: inject('adminUrl') });
    await admin.connect();
    await seedReferenceData(admin);
    planId = z
      .object({ id: z.string() })
      .parse((await admin.query(`SELECT id FROM plans WHERE code = 'free'`)).rows[0]).id;
    owner = await seedWorkspace(database, 'NotifyOwner', planId);
    outsider = await seedWorkspace(database, 'NotifyOutsider', planId);
    for (const role of ['editor', 'viewer', 'supervisor'] as const) {
      const fixture = await seedWorkspace(database, `Notify${role}`, planId);
      members[role] = fixture.userId;
      await database.withWorkspace(owner.workspaceId, (tx) =>
        tx
          .insert(schema.memberships)
          .values({ workspaceId: owner.workspaceId, userId: fixture.userId, role }),
      );
    }
  });

  afterAll(async () => {
    await database.close();
    await admin.end();
  });

  it('stores ids and a kind only: no text, title, name or email column', async () => {
    const result = await admin.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_name = 'notifications' ORDER BY column_name`,
    );
    expect(result.rows.map((row) => row.column_name)).toEqual([
      'created_at',
      'entity_id',
      'entity_type',
      'id',
      'kind',
      'project_id',
      'read_at',
      'recipient_user_id',
      'workspace_id',
    ]);
  });

  it('a review comment or suggestion notifies owners and editors, never the author', async () => {
    const documentId = await draftWithSentence();
    await addComment(database, ctx(members.supervisor), documentId, {
      anchor: anchorOf('المنهج الوصفي'),
      body: 'لماذا هذا المنهج؟',
    });
    await addSuggestion(database, ctx(members.supervisor), documentId, {
      anchor: anchorOf('تحليل البيانات'),
      replacement: 'تحليل بيانات الاستبانة',
    });
    const both: [NotificationKind, string][] = [
      ['review_comment', owner.workspaceId],
      ['review_comment', owner.workspaceId],
    ];
    expect(await about(owner.userId, documentId)).toEqual(both);
    expect(await about(members.editor, documentId)).toEqual(both);
    expect(await about(members.supervisor, documentId)).toEqual([]);
    expect(await about(members.viewer, documentId)).toEqual([]);
    expect(await about(outsider.userId, documentId)).toEqual([]);

    // An editor's comment reaches the owner but not the editor themself.
    await addComment(database, ctx(members.editor), documentId, {
      anchor: anchorOf('الدراسة'),
      body: 'ملاحظة',
    });
    expect(await about(owner.userId, documentId)).toHaveLength(3);
    expect(await about(members.editor, documentId)).toHaveLength(2);

    const { notifications } = await listNotifications(database, reader(owner.userId));
    expect(notifications[0]).toMatchObject({
      kind: 'review_comment',
      entityType: 'document',
      entityId: documentId,
      projectId: owner.projectId,
      projectTitle: 'مشروع NotifyOwner',
      workspaceName: 'Workspace NotifyOwner',
      readAt: null,
    });
  });

  it('deciding on a suggestion notifies its author', async () => {
    const documentId = await draftWithSentence();
    const declined = await addSuggestion(database, ctx(members.supervisor), documentId, {
      anchor: anchorOf('تحليل البيانات'),
      replacement: 'تحليل بيانات المقابلات',
    });
    const taken = await addSuggestion(database, ctx(members.supervisor), documentId, {
      anchor: anchorOf('المنهج الوصفي'),
      replacement: 'المنهج التجريبي',
    });
    await rejectSuggestion(database, ctx(owner.userId), documentId, declined.id);
    await acceptSuggestion(database, ctx(members.editor), documentId, taken.id, {
      baseVersion: 2,
    });
    expect(await about(members.supervisor, documentId)).toEqual([
      ['suggestion_decided', owner.workspaceId],
      ['suggestion_decided', owner.workspaceId],
    ]);
    // The owner got the two review notes, not the decisions.
    expect((await about(owner.userId, documentId)).map(([kind]) => kind)).toEqual([
      'review_comment',
      'review_comment',
    ]);
  });

  it('ingestion tells the uploader once whether the file is ready or failed', async () => {
    const readyId = await registerFile(members.editor);
    const input = {
      userId: members.editor,
      workspaceId: owner.workspaceId,
      projectId: owner.projectId,
      fileId: readyId,
      manifest: manifestFor('نص مستخرج للاختبار'),
    };
    await ingestExtraction(database, input);
    await ingestExtraction(database, input); // an idempotent retry adds nothing
    expect(await about(members.editor, readyId)).toEqual([['source_ready', owner.workspaceId]]);
    expect(await about(owner.userId, readyId)).toEqual([]);

    const emptyId = await registerFile(members.editor);
    await ingestExtraction(database, { ...input, fileId: emptyId, manifest: manifestFor('') });
    expect(await about(members.editor, emptyId)).toEqual([['source_failed', owner.workspaceId]]);

    // A job running as the owner still notifies the editor who uploaded the file.
    const failedId = await registerFile(members.editor);
    await markFileFailed(database, ctx(owner.userId), failedId, 'EXTRACTION_FAILED');
    await markFileFailed(database, ctx(owner.userId), failedId, 'EXTRACTION_FAILED');
    expect(await about(members.editor, failedId)).toEqual([['source_failed', owner.workspaceId]]);
    expect(await about(owner.userId, failedId)).toEqual([]);
  });

  it('joining notifies the owners; a role change notifies the member', async () => {
    const joiner = await seedWorkspace(database, 'NotifyJoiner', planId);
    const email = await emailOf(joiner.userId);
    const { token } = await inviteMember(
      database,
      { userId: owner.userId, workspaceId: owner.workspaceId },
      { email, role: 'viewer' },
    );
    await acceptInvitation(database, { userId: joiner.userId, email, emailVerified: true }, token);
    expect(await about(owner.userId, joiner.userId)).toEqual([
      ['member_joined', owner.workspaceId],
    ]);
    expect(await about(members.editor, joiner.userId)).toEqual([]);
    expect(await about(joiner.userId, joiner.userId)).toEqual([]);

    const actor = { userId: owner.userId, workspaceId: owner.workspaceId };
    await changeMemberRole(database, actor, joiner.userId, 'editor');
    await changeMemberRole(database, actor, joiner.userId, 'editor'); // no change, no notice
    expect(await about(joiner.userId, owner.workspaceId)).toEqual([
      ['role_changed', owner.workspaceId],
    ]);
    expect(await about(owner.userId, owner.workspaceId)).toEqual([]);

    // Removing a member removes their notifications in that workspace.
    await removeMember(database, actor, joiner.userId);
    expect(await about(joiner.userId, owner.workspaceId)).toEqual([]);
    const left = await admin.query(
      'SELECT count(*)::int AS n FROM notifications WHERE workspace_id = $1 AND recipient_user_id = $2',
      [owner.workspaceId, joiner.userId],
    );
    expect(left.rows).toEqual([{ n: 0 }]);
    // Their own workspace's notifications are untouched.
    expect((await listNotifications(database, reader(joiner.userId))).notifications).toHaveLength(
      1,
    );
  });

  it("a member reads and marks only their own notifications, never another member's", async () => {
    const documentId = await draftWithSentence();
    await addComment(database, ctx(members.supervisor), documentId, {
      anchor: anchorOf('الدراسة'),
      body: 'تعليق',
    });
    const ownerList = await listNotifications(database, reader(owner.userId));
    const editorList = await listNotifications(database, reader(members.editor));
    const ownerIds = ownerList.notifications.map((entry) => entry.id);
    const editorIds = new Set(editorList.notifications.map((entry) => entry.id));
    expect(ownerIds.length).toBeGreaterThan(0);
    expect(ownerIds.some((id) => editorIds.has(id))).toBe(false);

    // Another member's ids are ignored, even within the same workspace.
    expect(await markNotificationsRead(database, reader(members.editor), ownerIds)).toBe(0);
    expect(await markNotificationsRead(database, reader(outsider.userId), ownerIds)).toBe(0);
    expect(await unreadCount(database, reader(owner.userId))).toBe(ownerList.unreadCount);

    const [first] = ownerIds;
    expect(await markNotificationsRead(database, reader(owner.userId), [first ?? ''])).toBe(1);
    expect(await markNotificationsRead(database, reader(owner.userId), [first ?? ''])).toBe(0);
    expect(await unreadCount(database, reader(owner.userId))).toBe(ownerList.unreadCount - 1);
    const unread = await listNotifications(database, reader(owner.userId), { unreadOnly: true });
    expect(unread.notifications.map((entry) => entry.id)).not.toContain(first);

    const before = await unreadCount(database, reader(members.editor));
    expect(before).toBeGreaterThan(0);
    expect(await markNotificationsRead(database, reader(owner.userId), 'all')).toBe(
      ownerList.unreadCount - 1,
    );
    expect(await unreadCount(database, reader(owner.userId))).toBe(0);
    // The editor's notifications are still unread.
    expect(await unreadCount(database, reader(members.editor))).toBe(before);
  });

  it('lists across the user’s workspaces, and nothing from a workspace they are not in', async () => {
    const editorAll = await listNotifications(database, reader(members.editor), { limit: 100 });
    const spaces = new Set(editorAll.notifications.map((entry) => entry.workspaceId));
    // Their personal workspace (fixture notification) and the owner's workspace.
    expect(spaces.has(owner.workspaceId)).toBe(true);
    expect(spaces.size).toBe(2);

    const outsiderAll = await listNotifications(database, reader(outsider.userId), { limit: 100 });
    expect(outsiderAll.notifications.length).toBeGreaterThan(0);
    for (const entry of outsiderAll.notifications) {
      expect(entry.workspaceId).toBe(outsider.workspaceId);
    }
    // Asking for a workspace they are not a member of yields nothing.
    expect(
      await listNotifications(database, {
        userId: outsider.userId,
        workspaceId: owner.workspaceId,
      }),
    ).toEqual({ notifications: [], unreadCount: 0 });
    expect(
      await markNotificationsRead(
        database,
        { userId: outsider.userId, workspaceId: owner.workspaceId },
        'all',
      ),
    ).toBe(0);
  });

  it('notify is best effort: non-members get nothing and a failure keeps the transaction', async () => {
    const outcome = await database.withWorkspace(
      owner.workspaceId,
      async (tx) => {
        const toOutsider = await notify(tx, {
          workspaceId: owner.workspaceId,
          kind: 'role_changed',
          entityType: 'workspace',
          entityId: owner.workspaceId,
          userIds: [outsider.userId],
        });
        const broken = await notify(tx, {
          workspaceId: owner.workspaceId,
          kind: 'role_changed',
          entityType: 'workspace',
          entityId: 'not-a-uuid',
          userIds: [owner.userId],
        });
        // The transaction is still usable after the failed savepoint.
        const alive = await tx.execute(sql`select 1 as ok`);
        return { toOutsider, broken, alive: alive.rows };
      },
      { userId: owner.userId },
    );
    expect(outcome).toEqual({ toOutsider: 0, broken: 0, alive: [{ ok: 1 }] });
  });

  it('refuses malformed input', async () => {
    await expect(listNotifications(database, { userId: 'nope' })).rejects.toMatchObject({
      code: 'SANAD_INVALID_INPUT',
    });
    await expect(
      markNotificationsRead(database, reader(owner.userId), ['not-a-uuid']),
    ).rejects.toMatchObject({ code: 'SANAD_INVALID_INPUT' });
    await expect(markNotificationsRead(database, reader(owner.userId), [])).rejects.toMatchObject({
      code: 'SANAD_INVALID_INPUT',
    });
    await expect(
      listNotifications(database, reader(owner.userId), { limit: 1000 }),
    ).rejects.toMatchObject({ code: 'SANAD_INVALID_INPUT' });
  });
});
