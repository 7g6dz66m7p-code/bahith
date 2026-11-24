import type { CslItem } from '@bahith/citations';
import { parseCslJson } from '@bahith/citations';
import type { ZoteroLibrary } from '@bahith/scholarly';
import { isScholarlyError } from '@bahith/scholarly';

/** Whole-import budget across every page and retry; past it the import fails clearly. */
export const ZOTERO_IMPORT_TIMEOUT_MS = 60_000;

/**
 * The CSL items of a Zotero library page set: validated by the same CSL schema as file
 * imports. Malformed entries are counted, not fatal.
 */
export function cslItemsFromZotero(library: ZoteroLibrary): {
  items: CslItem[];
  invalid: number;
} {
  if (library.items.length === 0) return { items: [], invalid: 0 };
  return parseCslJson(library.items);
}

/**
 * A Zotero failure as a stable code for the user, or null when the error is not one. The
 * user's key and id never appear: only the HTTP status decides the code.
 */
export function zoteroFailure(error: unknown): { status: number; code: string } | null {
  if (error instanceof DOMException && ['TimeoutError', 'AbortError'].includes(error.name)) {
    return { status: 504, code: 'ZOTERO_TIMEOUT' };
  }
  if (!isScholarlyError(error)) return null;
  switch (error.code) {
    case 'SCHOLARLY_INVALID_INPUT':
      return { status: 400, code: 'ZOTERO_INVALID_CREDENTIALS' };
    case 'SCHOLARLY_NOT_FOUND':
      return { status: 422, code: 'ZOTERO_LIBRARY_NOT_FOUND' };
    case 'SCHOLARLY_RATE_LIMITED':
      return { status: 503, code: 'ZOTERO_RATE_LIMITED' };
    case 'SCHOLARLY_TIMEOUT':
      return { status: 504, code: 'ZOTERO_TIMEOUT' };
    default:
      // 401/403: the key is wrong, expired or lacks library read access.
      return error.status === 401 || error.status === 403
        ? { status: 422, code: 'ZOTERO_KEY_REJECTED' }
        : { status: 503, code: 'ZOTERO_UNAVAILABLE' };
  }
}
