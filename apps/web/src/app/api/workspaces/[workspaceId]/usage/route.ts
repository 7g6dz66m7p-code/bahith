import { getWorkspaceUsage, MemberError } from '@bahith/db';

import { apiError } from '@/server/api';
import { paymentProvider } from '@/server/billing';
import { getDatabase } from '@/server/db';
import { memberErrorResponse, workspaceActor } from '@/server/members';
import { unauthenticated } from '@/server/project-context';

type Params = { params: Promise<{ workspaceId: string }> };

/** The workspace's plan, this month's AI usage, and whether upgrading is possible. */
export async function GET(request: Request, { params }: Params) {
  try {
    const actor = await workspaceActor(request, params);
    if (actor === null) return unauthenticated();
    const usage = await getWorkspaceUsage(getDatabase(), actor);
    return Response.json(
      { ...usage, paymentsEnabled: paymentProvider() !== null },
      { headers: { 'Cache-Control': 'private, no-store' } },
    );
  } catch (error) {
    if (error instanceof MemberError) return memberErrorResponse(error);
    return apiError(error);
  }
}
