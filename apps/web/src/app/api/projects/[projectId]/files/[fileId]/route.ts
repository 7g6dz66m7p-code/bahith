import { Readable } from 'node:stream';

import { getProjectFile, SanadError } from '@bahith/db';
import { PipelineError } from '@bahith/pipeline';
import { z } from 'zod';

import { apiError } from '@/server/api';
import { getDatabase } from '@/server/db';
import { getStorage } from '@/server/pipeline';
import { getRequestSession } from '@/server/session';

const paramsSchema = z.object({ projectId: z.uuid(), fileId: z.uuid() });

/**
 * Streams a stored source to an authorized project member so the browser viewer can
 * open it (PDFs at `#page=N`, the page an evidence passage comes from). The response
 * is sandboxed and never cached by shared caches.
 */
export async function GET(
  request: Request,
  context: { params: Promise<{ projectId: string; fileId: string }> },
) {
  try {
    const session = await getRequestSession(request);
    if (session === null) return Response.json({ code: 'AUTH_REQUIRED' }, { status: 401 });
    const params = paramsSchema.safeParse(await context.params);
    const workspaceId = z.uuid().safeParse(new URL(request.url).searchParams.get('workspaceId'));
    if (!params.success || !workspaceId.success) throw new SanadError('SANAD_INVALID_INPUT');

    const file = await getProjectFile(
      getDatabase(),
      { userId: session.user.id, workspaceId: workspaceId.data, projectId: params.data.projectId },
      params.data.fileId,
    );
    const object = await getStorage().getStream(file.storageKey);
    const headers = new Headers({
      'Content-Type': file.mimeType,
      'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(file.originalName)}`,
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    // Uploaded content must never run script in our origin. PDFs are rendered by the
    // browser's own viewer (which refuses sandboxed documents), so they are exempt;
    // every other type (text, images) is served in a sandbox.
    if (file.mimeType !== 'application/pdf') {
      headers.set('Content-Security-Policy', "sandbox; default-src 'none'; img-src 'self'");
    }
    if (object.contentLength !== undefined)
      headers.set('Content-Length', String(object.contentLength));
    return new Response(Readable.toWeb(object.body) as ReadableStream, { headers });
  } catch (error) {
    if (error instanceof PipelineError) {
      return Response.json({ code: 'STORAGE_UNAVAILABLE' }, { status: 503 });
    }
    return apiError(error);
  }
}
