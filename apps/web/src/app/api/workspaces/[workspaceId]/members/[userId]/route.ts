import { changeMemberRole, MemberError, removeMember } from '@bahith/db';
import { z } from 'zod';

import { apiError, readJsonBody, requireSameOrigin } from '@/server/api';
import { getDatabase } from '@/server/db';
import { memberErrorResponse, workspaceActor } from '@/server/members';
import { unauthenticated } from '@/server/project-context';

type Params = { params: Promise<{ workspaceId: string; userId: string }> };

const bodySchema = z.strictObject({ role: z.enum(['owner', 'editor', 'viewer', 'supervisor']) });

/** Owner changes a member's role. */
export async function PATCH(request: Request, { params }: Params) {
  try {
    const actor = await workspaceActor(request, params);
    if (actor === null) return unauthenticated();
    requireSameOrigin(request);
    const body = bodySchema.safeParse(await readJsonBody(request));
    if (!body.success) throw new MemberError('MEMBER_INVALID_INPUT');
    await changeMemberRole(getDatabase(), actor, (await params).userId, body.data.role);
    return Response.json({ ok: true });
  } catch (error) {
    if (error instanceof MemberError) return memberErrorResponse(error);
    return apiError(error);
  }
}

/** Owner removes a member, or a member leaves (own id). */
export async function DELETE(request: Request, { params }: Params) {
  try {
    const actor = await workspaceActor(request, params);
    if (actor === null) return unauthenticated();
    requireSameOrigin(request);
    await removeMember(getDatabase(), actor, (await params).userId);
    return Response.json({ ok: true });
  } catch (error) {
    if (error instanceof MemberError) return memberErrorResponse(error);
    return apiError(error);
  }
}
