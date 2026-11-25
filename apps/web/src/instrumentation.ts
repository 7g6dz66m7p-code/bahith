import type { Instrumentation } from 'next';

import { requestErrorRecord } from './lib/request-error-log';

/** Structured, content-free error logging for every server request (see request-error-log.ts). */
export const onRequestError: Instrumentation.onRequestError = async (error, request, context) => {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  const { writeRequestError } = await import('./lib/request-error-sink');
  writeRequestError(requestErrorRecord(error, request, context));
};
