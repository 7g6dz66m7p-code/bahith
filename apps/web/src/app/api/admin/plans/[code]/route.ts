import { PlanError, setPlanAiRequestLimit } from '@bahith/db';
import { z } from 'zod';

import { apiError, readJsonBody, requireSameOrigin } from '@/server/api';
import { getDatabase } from '@/server/db';
import { isPlatformAdmin } from '@/server/platform-admin';
import { unauthenticated } from '@/server/project-context';
import { getRequestSession } from '@/server/session';

type Params = { params: Promise<{ code: string }> };

const bodySchema = z.strictObject({ aiRequestsPerMonth: z.number().int().min(0).max(1_000_000) });

/** Sets a plan's monthly AI request limit (platform administrators only). */
export async function PUT(request: Request, { params }: Params) {
  try {
    const session = await getRequestSession(request);
    if (session === null) return unauthenticated();
    if (!isPlatformAdmin(session)) return Response.json({ code: 'ADMIN_ONLY' }, { status: 404 });
    requireSameOrigin(request);
    const body = bodySchema.safeParse(await readJsonBody(request));
    if (!body.success) return Response.json({ code: 'PLAN_INVALID' }, { status: 400 });
    const limits = await setPlanAiRequestLimit(
      getDatabase(),
      (await params).code,
      body.data.aiRequestsPerMonth,
    );
    return Response.json({ limits });
  } catch (error) {
    if (error instanceof PlanError) {
      return Response.json(
        { code: error.code },
        { status: error.code === 'PLAN_NOT_FOUND' ? 404 : 400 },
      );
    }
    return apiError(error);
  }
}
