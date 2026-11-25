/** Stable, machine-readable error codes raised by @bahith/export. */
export type ExportErrorCode =
  /** The input failed schema validation; see `issues`. */
  | 'EXPORT_INVALID_DOCUMENT'
  /** The PDF renderer (Playwright Chromium) could not be started. */
  | 'EXPORT_RENDERER_UNAVAILABLE'
  /** The renderer started but failed or timed out while producing the file. */
  | 'EXPORT_RENDER_FAILED';

/** One validation problem: a dotted path into the input and a stable detail code. */
export interface ExportIssue {
  path: string;
  /** e.g. `EMPTY_TITLE`, `INVALID_HEADING_LEVEL`; `INVALID_FIELD` when no specific code applies. */
  code: string;
}

/**
 * Error raised by @bahith/export. `code` and `issues` are stable and safe to expose;
 * `message` is for developers and never contains document text.
 */
export class ExportError extends Error {
  readonly code: ExportErrorCode;
  readonly issues: readonly ExportIssue[];

  constructor(
    code: ExportErrorCode,
    options: { issues?: readonly ExportIssue[]; cause?: unknown } = {},
  ) {
    super(code, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'ExportError';
    this.code = code;
    this.issues = options.issues ?? [];
  }
}
