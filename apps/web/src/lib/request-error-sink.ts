import type { RequestErrorRecord } from './request-error-log';

/** Node.js runtime only (imported from instrumentation.ts under NEXT_RUNTIME === 'nodejs'). */
export function writeRequestError(record: RequestErrorRecord): void {
  process.stderr.write(`${JSON.stringify(record)}\n`);
}
