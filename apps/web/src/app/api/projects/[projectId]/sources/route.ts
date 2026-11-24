import { randomUUID, createHash } from 'node:crypto';

import {
  listProjectLibrary,
  markFileFailed,
  markFileQueued,
  MAX_UPLOAD_BYTES,
  registerUpload,
  SanadError,
  withSanadProject,
} from '@bahith/db';
import { fileObjectKey, PipelineError, sniffMimeType } from '@bahith/pipeline';
import { z } from 'zod';

import { apiError, requireSameOrigin } from '@/server/api';
import { getDatabase } from '@/server/db';
import { getQueues, getStorage } from '@/server/pipeline';
import { getRequestSession } from '@/server/session';
import { readUploadForm, UploadBodyTooLargeError } from '@/server/upload-body';

const paramsSchema = z.object({ projectId: z.uuid() });
const workspaceSchema = z.uuid();

/** Multipart overhead allowance on top of the 50 MB file limit. */
const MAX_REQUEST_BYTES = MAX_UPLOAD_BYTES + 1024 * 1024;

interface RouteContext {
  params: Promise<{ projectId: string }>;
}

async function resolveContext(request: Request, context: RouteContext) {
  const session = await getRequestSession(request);
  if (session === null) return null;
  const params = paramsSchema.safeParse(await context.params);
  const workspaceId = workspaceSchema.safeParse(
    new URL(request.url).searchParams.get('workspaceId'),
  );
  if (!params.success || !workspaceId.success) throw new SanadError('SANAD_INVALID_INPUT');
  return {
    userId: session.user.id,
    workspaceId: workspaceId.data,
    projectId: params.data.projectId,
  };
}

export async function GET(request: Request, context: RouteContext) {
  try {
    const project = await resolveContext(request, context);
    if (project === null) return Response.json({ code: 'AUTH_REQUIRED' }, { status: 401 });
    return Response.json(
      { sources: await listProjectLibrary(getDatabase(), project) },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (error) {
    return apiError(error);
  }
}

/**
 * Upload one source file (multipart field `file`). The type is decided from the bytes,
 * not from the browser or the extension; at most 50 MB. Identical bytes already in the
 * workspace are linked instead of stored twice.
 */
export async function POST(request: Request, context: RouteContext) {
  try {
    const project = await resolveContext(request, context);
    if (project === null) return Response.json({ code: 'AUTH_REQUIRED' }, { status: 401 });
    requireSameOrigin(request);
    const database = getDatabase();
    // Reject revoked/view-only/foreign project access before consuming bytes or
    // writing to S3. registerUpload rechecks authorization inside its transaction.
    await withSanadProject(database, project, true, () => Promise.resolve());

    const form = await readUploadForm(request, MAX_REQUEST_BYTES);
    const file = form?.get('file');
    if (!(file instanceof File)) return Response.json({ code: 'UPLOAD_MISSING' }, { status: 400 });
    if (file.size === 0 || file.size > MAX_UPLOAD_BYTES) {
      return Response.json({ code: 'UPLOAD_TOO_LARGE' }, { status: 413 });
    }
    const bytes = new Uint8Array(await file.arrayBuffer());
    const mimeType = sniffMimeType(bytes);
    if (mimeType === null)
      return Response.json({ code: 'UPLOAD_UNSUPPORTED_TYPE' }, { status: 415 });

    const fileId = randomUUID();
    const storageKey = fileObjectKey(project.workspaceId, fileId);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const storage = getStorage();
    await storage.put(storageKey, bytes, mimeType);

    const registered = await registerUpload(database, project, {
      fileId,
      originalName: file.name.normalize('NFC').slice(0, 255) || 'source',
      mimeType,
      sizeBytes: bytes.byteLength,
      sha256,
      storageKey,
    }).catch(async (error: unknown) => {
      await storage.delete(storageKey).catch(() => undefined);
      throw error;
    });

    if (registered.duplicate) {
      // The bytes already exist under the original file: drop the redundant copy.
      await storage.delete(storageKey).catch(() => undefined);
      return Response.json({ upload: registered }, { status: 200 });
    }
    try {
      await getQueues().enqueueExtraction({ ...project, fileId, storageKey, mimeType, sha256 });
      await markFileQueued(database, project, fileId);
    } catch (error) {
      await markFileFailed(database, project, fileId, 'QUEUE_UNAVAILABLE').catch(() => undefined);
      throw error;
    }
    return Response.json({ upload: { ...registered, status: 'processing' } }, { status: 201 });
  } catch (error) {
    if (error instanceof UploadBodyTooLargeError) {
      return Response.json({ code: 'UPLOAD_TOO_LARGE' }, { status: 413 });
    }
    if (error instanceof PipelineError) {
      return Response.json(
        {
          code:
            error.code === 'PIPELINE_CONFIG_MISSING'
              ? 'STORAGE_NOT_CONFIGURED'
              : 'STORAGE_UNAVAILABLE',
        },
        { status: 503 },
      );
    }
    return apiError(error);
  }
}
