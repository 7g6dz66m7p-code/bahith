import { MemberError, revokeInvitation } from '@bahith/db';

import { apiError, requireSameOrigin } from '@/server/api';
import { getDatabase } from '@/server/db';
import { memberErrorResponse, workspaceActor } from '@/server/members';
import { unauthenticated } from '@/server/project-context';

type Params = { params: Promise<{ workspaceId: string; invitationId: string }> };

/** Owner revokes a pending invitation. */
export async function DELETE(request: Request, { params }: Params) {
  try {
    const actor = await workspaceActor(request, params);
    if (actor === null) return unauthenticated();
    requireSameOrigin(request);
    await revokeInvitation(getDatabase(), actor, (await params).invitationId);
    return Response.json({ ok: true });
  } catch (error) {
    if (error instanceof MemberError) return memberErrorResponse(error);
    return apiError(error);
  }
}
