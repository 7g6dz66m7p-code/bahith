/** Structural integrity gate only: semantic support requires separate review. */
export type ClaimKind = 'fact' | 'inference' | 'hypothesis';
export interface Evidence {
  workspaceId: string;
  sourceVersionId: string;
  metadataVerified: boolean;
  availability: 'fulltext' | 'abstract' | 'metadata_only' | 'unavailable';
  sourceText: string;
  quote: string;
  start: number;
  end: number;
  locator: { kind: 'pdf_page'; index: number; printedLabel?: string } |
           { kind: 'paragraph'; index: number };
  review: 'pending' | 'supported' | 'partial' | 'contradicted';
  reviewerId?: string;
}
export function validateEvidence(workspaceId: string, e: Evidence): string[] {
  const errors: string[] = [];
  if (!workspaceId || workspaceId !== e.workspaceId) errors.push('TENANT_MISMATCH');
  if (!e.sourceVersionId || !e.metadataVerified) errors.push('UNVERIFIED_SOURCE');
  if (!['fulltext', 'abstract'].includes(e.availability)) errors.push('TEXT_UNAVAILABLE');
  if (!Number.isInteger(e.start) || !Number.isInteger(e.end) || e.start < 0 ||
      e.end <= e.start || e.end > e.sourceText.length || !e.quote.trim() ||
      e.sourceText.slice(e.start, e.end) !== e.quote) errors.push('QUOTE_MISMATCH');
  if (!Number.isInteger(e.locator.index) || e.locator.index < 1) errors.push('INVALID_LOCATOR');
  return errors;
}
export function canApproveClaim(workspaceId: string, kind: ClaimKind, evidence: Evidence[]): boolean {
  // Hypotheses are never approved as established findings by this gate.
  if (kind === 'hypothesis' || evidence.length === 0) return false;
  return evidence.every(e => validateEvidence(workspaceId, e).length === 0 &&
    e.availability === 'fulltext' && e.review === 'supported' && !!e.reviewerId?.trim());
}
