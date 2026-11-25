import { acceptInvitation, MemberError } from '@bahith/db';
import { z } from 'zod';

import { apiError, readJsonBody, requireSameOrigin } from '@/server/api';
import { getDatabase } from '@/server/db';
import { memberErrorResponse } from '@/server/members';
import { unauthenticated } from '@/server/project-context';
import { getRequestSession } from '@/server/session';

const bodySchema = z.strictObject({ token: z.string().min(10).max(200) });

/** The signed-in user (verified email from the session, never the body) accepts. */
export async function POST(request: Request) {
  try {
    const session = await getRequestSession(request);
    if (session === null) return unauthenticated();
    requireSameOrigin(request);
    const body = bodySchema.safeParse(await readJsonBody(request));
    if (!body.success) throw new MemberError('INVITATION_INVALID');
    const result = await acceptInvitation(
      getDatabase(),
      {
        userId: session.user.id,
        email: session.user.email,
        emailVerified: session.user.emailVerified,
      },
      body.data.token,
    );
    return Response.json(result);
  } catch (error) {
    if (error instanceof MemberError) return memberErrorResponse(error);
    return apiError(error);
  }
}
