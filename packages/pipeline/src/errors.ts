export type PipelineErrorCode =
  | 'PIPELINE_CONFIG_MISSING'
  | 'PIPELINE_INVALID_PAYLOAD'
  | 'STORAGE_NOT_FOUND'
  | 'STORAGE_TOO_LARGE'
  | 'STORAGE_UNAVAILABLE'
  | 'STORAGE_INTEGRITY';

/** Stable codes only: messages never contain object keys' contents or document text. */
export class PipelineError extends Error {
  readonly code: PipelineErrorCode;

  constructor(code: PipelineErrorCode, options?: ErrorOptions) {
    super(code, options);
    this.name = 'PipelineError';
    this.code = code;
  }
}
