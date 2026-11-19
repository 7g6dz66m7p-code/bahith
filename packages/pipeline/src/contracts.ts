import { z } from 'zod';

/**
 * Queue contracts shared with the Python worker (apps/worker/src/bahith_worker/jobs).
 * The JSON files in ../contracts are canonical examples validated by both test suites.
 *
 *   web ──sanad.extract──▶ [bahith-documents] ──▶ Python worker (download, extract, OCR)
 *   Python ──sanad.ingest──▶ [bahith-ingest] ──▶ Node jobs (validate manifest, ingest)
 *
 * Payloads carry identifiers only — never document text, titles or file names.
 */
export const EXTRACT_QUEUE = 'bahith-documents';
export const INGEST_QUEUE = 'bahith-ingest';
export const EXTRACT_JOB = 'sanad.extract';
export const INGEST_JOB = 'sanad.ingest';

const context = {
  /** Authenticated user who uploaded the file; re-authorized at ingestion time. */
  userId: z.uuid(),
  workspaceId: z.uuid(),
  projectId: z.uuid(),
  fileId: z.uuid(),
};

export const extractJobSchema = z.strictObject({
  ...context,
  storageKey: z.string().min(1).max(512),
  mimeType: z.enum([
    'application/pdf',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'text/plain',
    'image/png',
    'image/jpeg',
    'image/tiff',
  ]),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
});

export type ExtractJob = z.infer<typeof extractJobSchema>;

export const ingestJobSchema = z.discriminatedUnion('outcome', [
  z.strictObject({
    ...context,
    outcome: z.literal('extracted'),
    manifestKey: z.string().min(1).max(600),
  }),
  z.strictObject({
    ...context,
    outcome: z.literal('failed'),
    code: z.string().regex(/^[A-Z][A-Z0-9_]{0,79}$/),
  }),
]);

export type IngestJob = z.infer<typeof ingestJobSchema>;
