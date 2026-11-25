import { addComment, addSuggestion, listComments, SanadError } from '@bahith/db';
import { z } from 'zod';

import { apiError, readJsonBody, requireSameOrigin } from '@/server/api';
import { getDatabase } from '@/server/db';
import { projectContext, unauthenticated } from '@/server/project-context';

type Params = { params: Promise<{ projectId: string; documentId: string }> };

/** Review notes of a draft (comments and suggested changes); any member may read them. */
export async function GET(request: Request, { params }: Params) {
  try {
    const context = await projectContext(request, params);
    if (context === null) return unauthenticated();
    return Response.json(
      { comments: await listComments(getDatabase(), context, (await params).documentId) },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (error) {
    return apiError(error);
  }
}

const kindSchema = z.looseObject({ kind: z.enum(['comment', 'suggestion']) });

/** Adds a comment or a suggestion; owners, editors and supervisors. The author is the session user. */
export async function POST(request: Request, { params }: Params) {
  try {
    const context = await projectContext(request, params);
    if (context === null) return unauthenticated();
    requireSameOrigin(request);
    const body = kindSchema.safeParse(await readJsonBody(request));
    if (!body.success) throw new SanadError('SANAD_INVALID_INPUT');
    const { kind, ...input } = body.data;
    const { documentId } = await params;
    const comment =
      kind === 'comment'
        ? await addComment(getDatabase(), context, documentId, input)
        : await addSuggestion(getDatabase(), context, documentId, input);
    return Response.json({ comment }, { status: 201 });
  } catch (error) {
    return apiError(error);
  }
}
