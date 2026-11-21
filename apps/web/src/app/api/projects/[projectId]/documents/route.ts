import { createDocument, listDocuments } from '@bahith/db';

import { apiError, readJsonBody, requireSameOrigin } from '@/server/api';
import { getDatabase } from '@/server/db';
import { projectContext, unauthenticated } from '@/server/project-context';

type Params = { params: Promise<{ projectId: string }> };

export async function GET(request: Request, { params }: Params) {
  try {
    const context = await projectContext(request, params);
    if (context === null) return unauthenticated();
    return Response.json({ documents: await listDocuments(getDatabase(), context) });
  } catch (error) {
    return apiError(error);
  }
}

export async function POST(request: Request, { params }: Params) {
  try {
    const context = await projectContext(request, params);
    if (context === null) return unauthenticated();
    requireSameOrigin(request);
    const document = await createDocument(getDatabase(), context, await readJsonBody(request));
    return Response.json({ document }, { status: 201 });
  } catch (error) {
    return apiError(error);
  }
}
