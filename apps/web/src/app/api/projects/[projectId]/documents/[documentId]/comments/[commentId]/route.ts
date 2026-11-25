import { acceptSuggestion, rejectSuggestion, resolveComment, SanadError } from '@bahith/db';
import { z } from 'zod';

import { apiError, readJsonBody, requireSameOrigin } from '@/server/api';
import { getDatabase } from '@/server/db';
import { projectContext, unauthenticated } from '@/server/project-context';

type Params = { params: Promise<{ projectId: string; documentId: string; commentId: string }> };

const actionSchema = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('resolve') }),
  z.strictObject({ action: z.literal('reject') }),
  z.strictObject({ action: z.literal('accept'), baseVersion: z.number().int().min(1) }),
]);

/**
 * Closes a review note. `resolve` (comments): owners, editors, supervisors. `accept` /
 * `reject` (suggestions): owners and editors. Accepting answers with the new version;
 * 409 DOCUMENT_VERSION_CONFLICT when the draft changed since `baseVersion`, and 409
 * REVIEW_ANCHOR_STALE when the quoted text is no longer where the suggestion points.
 */
export async function PATCH(request: Request, { params }: Params) {
  try {
    const context = await projectContext(request, params);
    if (context === null) return unauthenticated();
    requireSameOrigin(request);
    const parsed = actionSchema.safeParse(await readJsonBody(request));
    if (!parsed.success) throw new SanadError('SANAD_INVALID_INPUT');
    const { documentId, commentId } = await params;
    const database = getDatabase();
    const body = parsed.data;
    if (body.action === 'accept') {
      return Response.json(
        await acceptSuggestion(database, context, documentId, commentId, {
          baseVersion: body.baseVersion,
        }),
      );
    }
    const comment =
      body.action === 'resolve'
        ? await resolveComment(database, context, documentId, commentId)
        : await rejectSuggestion(database, context, documentId, commentId);
    return Response.json({ comment });
  } catch (error) {
    if (error instanceof SanadError && error.code === 'SANAD_VERSION_CONFLICT') {
      return Response.json({ code: 'DOCUMENT_VERSION_CONFLICT' }, { status: 409 });
    }
    return apiError(error);
  }
}
