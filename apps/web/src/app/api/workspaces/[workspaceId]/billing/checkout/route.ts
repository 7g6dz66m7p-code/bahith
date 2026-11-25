import { listMembers, MemberError } from '@bahith/db';
import { z } from 'zod';

import { apiError, readJsonBody, requireSameOrigin } from '@/server/api';
import { PaymentsDisabledError, startCheckout } from '@/server/billing';
import { getDatabase } from '@/server/db';
import { memberErrorResponse, workspaceActor } from '@/server/members';
import { unauthenticated } from '@/server/project-context';

type Params = { params: Promise<{ workspaceId: string }> };

const bodySchema = z.strictObject({ planCode: z.string().regex(/^[a-z][a-z0-9-]{0,39}$/u) });

/** Starts an upgrade checkout (owner only). Disabled until payments are authorized. */
export async function POST(request: Request, { params }: Params) {
  try {
    const actor = await workspaceActor(request, params);
    if (actor === null) return unauthenticated();
    requireSameOrigin(request);
    const body = bodySchema.safeParse(await readJsonBody(request));
    if (!body.success) throw new MemberError('MEMBER_INVALID_INPUT');
    const members = await listMembers(getDatabase(), actor);
    if (!members.some((member) => member.isYou && member.role === 'owner')) {
      throw new MemberError('MEMBER_FORBIDDEN');
    }
    const checkout = await startCheckout({ ...actor, planCode: body.data.planCode });
    return Response.json(checkout);
  } catch (error) {
    if (error instanceof PaymentsDisabledError) {
      return Response.json({ code: error.code }, { status: 503 });
    }
    if (error instanceof MemberError) return memberErrorResponse(error);
    return apiError(error);
  }
}
