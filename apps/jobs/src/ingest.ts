import type { Database } from '@bahith/db';
import { ingestExtraction, markFileFailed, recordProjectAudit, SanadError } from '@bahith/db';
import type { ObjectStorage } from '@bahith/pipeline';
import { ingestJobSchema, manifestObjectKey, PipelineError } from '@bahith/pipeline';
import { UnrecoverableError } from 'bullmq';

import { errorCode, log } from './log';

/** Manifests are JSON of the extracted text; 20M code points fit well under this. */
const MAX_MANIFEST_BYTES = 120 * 1024 * 1024;

export interface IngestDependencies {
  /** Called after a file became ready (e.g. to queue embedding of its passages). */
  onReady?: (context: { userId: string; workspaceId: string; projectId: string }) => Promise<void>;
  database: Database;
  storage: ObjectStorage;
}

export type IngestOutcome =
  | { status: 'ready' | 'failed'; chunkCount: number; reused: boolean }
  | { status: 'failed'; code: string };

/**
 * Handles one `sanad.ingest` job. The acting user is re-authorized inside the ingestion
 * transaction, so a user who lost access after uploading cannot have the file ingested.
 * Permanent problems end the job without retries (UnrecoverableError); anything else
 * is thrown so BullMQ retries with backoff.
 */
export function createIngestHandler({ database, storage, onReady }: IngestDependencies) {
  return async (data: unknown): Promise<IngestOutcome> => {
    const parsed = ingestJobSchema.safeParse(data);
    if (!parsed.success) throw new UnrecoverableError('PIPELINE_INVALID_PAYLOAD');
    const job = parsed.data;
    const context = { userId: job.userId, workspaceId: job.workspaceId, projectId: job.projectId };
    const ids = { fileId: job.fileId, workspaceId: job.workspaceId };

    try {
      if (job.outcome === 'failed') {
        await markFileFailed(database, context, job.fileId, job.code);
        log.warn('source.extraction_failed', { ...ids, code: job.code });
        return { status: 'failed', code: job.code };
      }

      // The key must be the one this file's extraction is allowed to write.
      const expectedPrefix = manifestObjectKey(job.workspaceId, job.fileId, '0'.repeat(64)).replace(
        /0{64}\.json$/u,
        '',
      );
      if (!job.manifestKey.startsWith(expectedPrefix) || job.manifestKey.includes('..')) {
        await markFileFailed(database, context, job.fileId, 'MANIFEST_KEY_REJECTED');
        throw new UnrecoverableError('MANIFEST_KEY_REJECTED');
      }

      let manifest: unknown;
      try {
        const bytes = await storage.getBytes(job.manifestKey, MAX_MANIFEST_BYTES);
        manifest = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
      } catch (error) {
        if (error instanceof PipelineError && error.code === 'STORAGE_UNAVAILABLE') throw error;
        await markFileFailed(database, context, job.fileId, 'MANIFEST_UNREADABLE');
        throw new UnrecoverableError('MANIFEST_UNREADABLE');
      }

      let result: Awaited<ReturnType<typeof ingestExtraction>>;
      try {
        result = await ingestExtraction(database, { ...context, fileId: job.fileId, manifest });
      } catch (error) {
        if (
          error instanceof SanadError &&
          (error.code === 'SANAD_INVALID_INPUT' || error.code === 'SANAD_VERSION_CONFLICT')
        ) {
          await markFileFailed(database, context, job.fileId, 'MANIFEST_REJECTED');
          throw new UnrecoverableError('MANIFEST_REJECTED');
        }
        throw error;
      }
      await recordProjectAudit(database, context, {
        action: 'source.processed',
        entityType: 'file',
        entityId: job.fileId,
        metadata: {
          status: result.status,
          chunkCount: result.chunkIds.length,
          failureCount: result.failures.length,
          reused: result.reused,
        },
      });
      log.info('source.ingested', {
        ...ids,
        status: result.status,
        chunkCount: result.chunkIds.length,
        reused: result.reused,
      });
      if (result.status === 'ready' && onReady !== undefined) {
        // Best effort: the source is usable lexically even if queuing embedding fails.
        await onReady(context).catch((error: unknown) => {
          log.warn('sanad.embed_enqueue_failed', { ...ids, code: errorCode(error) });
        });
      }
      return {
        status: result.status === 'ready' ? 'ready' : 'failed',
        chunkCount: result.chunkIds.length,
        reused: result.reused,
      };
    } catch (error) {
      if (error instanceof UnrecoverableError) throw error;
      // The user lost access or the project is gone: nothing to retry.
      if (
        error instanceof SanadError &&
        ['SANAD_FORBIDDEN', 'SANAD_PROJECT_NOT_FOUND', 'SANAD_FILE_NOT_FOUND'].includes(error.code)
      ) {
        log.warn('source.ingest_refused', { ...ids, code: error.code });
        throw new UnrecoverableError(error.code);
      }
      log.error('source.ingest_error', { ...ids, code: errorCode(error) });
      throw error;
    }
  };
}
