import { SanadError } from '@bahith/db';
import { ExportError } from '@bahith/export';
import { z } from 'zod';

import { apiError } from '@/server/api';
import { getDatabase } from '@/server/db';
import { exportDraft } from '@/server/drafts';
import { projectContext, unauthenticated } from '@/server/project-context';

type Params = { params: Promise<{ projectId: string; documentId: string }> };

const formatSchema = z.enum(['docx', 'pdf', 'markdown', 'latex']);

/** Downloads the draft. Warnings travel in a header so the editor can show them. */
export async function GET(request: Request, { params }: Params) {
  try {
    const context = await projectContext(request, params);
    if (context === null) return unauthenticated();
    const format = formatSchema.safeParse(new URL(request.url).searchParams.get('format'));
    if (!format.success) throw new SanadError('SANAD_INVALID_INPUT');
    const result = await exportDraft(
      getDatabase(),
      context,
      (await params).documentId,
      format.data,
      context.userName,
    );
    const warnings = [
      ...result.warnings.map((warning) => `${warning.code}:${warning.count}`),
      ...(result.unverifiedSources > 0 ? [`UNVERIFIED_SOURCES:${result.unverifiedSources}`] : []),
    ];
    return new Response(Buffer.from(result.bytes), {
      headers: {
        'Content-Type': result.mime,
        'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(result.filename)}`,
        'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff',
        'X-Bahith-Export-Warnings': warnings.join(','),
      },
    });
  } catch (error) {
    if (error instanceof ExportError) {
      return Response.json({ code: error.code }, { status: 422 });
    }
    return apiError(error);
  }
}
