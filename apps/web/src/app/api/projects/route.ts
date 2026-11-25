import { createProject, listUserProjects } from '@bahith/db';

import { apiError, readJsonBody, requireSameOrigin } from '@/server/api';
import { getDatabase } from '@/server/db';
import { getRequestSession } from '@/server/session';

export async function GET(request: Request) {
  try {
    const session = await getRequestSession(request);
    if (session === null) return Response.json({ code: 'AUTH_REQUIRED' }, { status: 401 });
    return Response.json(await listUserProjects(getDatabase(), session.user.id));
  } catch (error) {
    return apiError(error);
  }
}

export async function POST(request: Request) {
  try {
    const session = await getRequestSession(request);
    if (session === null) return Response.json({ code: 'AUTH_REQUIRED' }, { status: 401 });
    requireSameOrigin(request);
    const project = await createProject(
      getDatabase(),
      session.user.id,
      await readJsonBody(request),
    );
    return Response.json({ project }, { status: 201 });
  } catch (error) {
    return apiError(error);
  }
}
