import { getDocument, saveDocument, SanadError } from '@bahith/db';
import { z } from 'zod';

import { apiError, readJsonBody, requireSameOrigin } from '@/server/api';
import { getDatabase } from '@/server/db';
import { projectContext, unauthenticated } from '@/server/project-context';

type Params = { params: Promise<{ projectId: string; documentId: string }> };

export async function GET(request: Request, { params }: Params) {
  try {
    const context = await projectContext(request, params);
    if (context === null) return unauthenticated();
    const version = new URL(request.url).searchParams.get('version');
    const parsedVersion =
      version === null ? undefined : z.coerce.number().int().min(1).parse(version);
    return Response.json(
      await getDocument(getDatabase(), context, (await params).documentId, parsedVersion),
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (error) {
    return apiError(error);
  }
}

/** Saves a new version; 409 when the draft changed since `baseVersion`. */
export async function PUT(request: Request, { params }: Params) {
  try {
    const context = await projectContext(request, params);
    if (context === null) return unauthenticated();
    requireSameOrigin(request);
    const body = await readJsonBody(request);
    const result = await saveDocument(getDatabase(), context, (await params).documentId, body);
    return Response.json(result);
  } catch (error) {
    if (error instanceof SanadError && error.code === 'SANAD_VERSION_CONFLICT') {
      return Response.json({ code: 'DOCUMENT_VERSION_CONFLICT' }, { status: 409 });
    }
    return apiError(error);
  }
}
