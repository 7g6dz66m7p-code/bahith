import { SanadError } from '@bahith/db';
import { z } from 'zod';

import { apiError, readJsonBody, requireSameOrigin } from '@/server/api';
import { askAssistant, AssistantRequestError } from '@/server/assistant';
import { getDatabase } from '@/server/db';
import { projectContext, unauthenticated } from '@/server/project-context';

type Params = { params: Promise<{ projectId: string }> };

const bodySchema = z.strictObject({
  question: z.string().trim().min(1).max(2000),
  conversationId: z.uuid().nullable().default(null),
  language: z.enum(['ar', 'en']),
});

/** Evidence-grounded answer from this project's sources (see server/assistant.ts). */
export async function POST(request: Request, { params }: Params) {
  try {
    const context = await projectContext(request, params);
    if (context === null) return unauthenticated();
    requireSameOrigin(request);
    const body = bodySchema.safeParse(await readJsonBody(request));
    if (!body.success) throw new SanadError('SANAD_INVALID_INPUT');
    const reply = await askAssistant(getDatabase(), context, body.data);
    return Response.json(reply, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (error) {
    if (error instanceof AssistantRequestError) {
      return Response.json({ code: error.code }, { status: error.status });
    }
    return apiError(error);
  }
}
