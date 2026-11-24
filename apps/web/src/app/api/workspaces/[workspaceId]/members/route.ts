import { inviteMember, listInvitations, listMembers, MemberError } from '@bahith/db';
import { z } from 'zod';

import { apiError, readJsonBody, requireSameOrigin } from '@/server/api';
import { getDatabase } from '@/server/db';
import {
  invitationLink,
  memberErrorResponse,
  sendInvitationEmail,
  workspaceActor,
} from '@/server/members';
import { unauthenticated } from '@/server/project-context';

type Params = { params: Promise<{ workspaceId: string }> };

/** Members of the workspace; owners also get the pending invitations. */
export async function GET(request: Request, { params }: Params) {
  try {
    const actor = await workspaceActor(request, params);
    if (actor === null) return unauthenticated();
    const database = getDatabase();
    const members = await listMembers(database, actor);
    const you = members.find((member) => member.isYou);
    const invitations = you?.role === 'owner' ? await listInvitations(database, actor) : [];
    return Response.json(
      { members, invitations },
      { headers: { 'Cache-Control': 'private, no-store' } },
    );
  } catch (error) {
    if (error instanceof MemberError) return memberErrorResponse(error);
    return apiError(error);
  }
}

const inviteSchema = z.strictObject({
  email: z.string().trim().min(3).max(320),
  role: z.enum(['editor', 'viewer', 'supervisor']),
  locale: z.enum(['ar', 'en']),
});

/** Owner invites by email; the link is returned once so it can also be shared by hand. */
export async function POST(request: Request, { params }: Params) {
  try {
    const actor = await workspaceActor(request, params);
    if (actor === null) return unauthenticated();
    requireSameOrigin(request);
    const body = inviteSchema.safeParse(await readJsonBody(request));
    if (!body.success) throw new MemberError('MEMBER_INVALID_INPUT');
    const invitation = await inviteMember(getDatabase(), actor, body.data);
    const link = invitationLink(body.data.locale, invitation.token);
    const emailSent = await sendInvitationEmail(body.data.email.toLowerCase(), link);
    return Response.json(
      { invitationId: invitation.invitationId, expiresAt: invitation.expiresAt, link, emailSent },
      { status: 201, headers: { 'Cache-Control': 'private, no-store' } },
    );
  } catch (error) {
    if (error instanceof MemberError) return memberErrorResponse(error);
    return apiError(error);
  }
}
