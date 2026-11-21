import { getProjectAiConsent, SanadError, setProjectAiConsent } from '@bahith/db';
import { z } from 'zod';

import { apiError, readJsonBody, requireSameOrigin } from '@/server/api';
import { configuredChatModel } from '@/server/assistant';
import { getDatabase } from '@/server/db';
import { projectContext, unauthenticated } from '@/server/project-context';

type Params = { params: Promise<{ projectId: string }> };

/** Whether this project may send passages to the AI provider, and which model that is. */
export async function GET(request: Request, { params }: Params) {
  try {
    const context = await projectContext(request, params);
    if (context === null) return unauthenticated();
    const consent = await getProjectAiConsent(getDatabase(), context);
    return Response.json({ ...consent, model: configuredChatModel() });
  } catch (error) {
    return apiError(error);
  }
}

const bodySchema = z.strictObject({ enabled: z.boolean() });

export async function PUT(request: Request, { params }: Params) {
  try {
    const context = await projectContext(request, params);
    if (context === null) return unauthenticated();
    requireSameOrigin(request);
    const body = bodySchema.safeParse(await readJsonBody(request));
    if (!body.success) throw new SanadError('SANAD_INVALID_INPUT');
    const consent = await setProjectAiConsent(getDatabase(), context, body.data.enabled);
    return Response.json({ ...consent, model: configuredChatModel() });
  } catch (error) {
    return apiError(error);
  }
}
