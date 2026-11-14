import { z } from 'zod';

export type SanadVerifyErrorCode =
  | 'SANAD_VERIFY_INVALID_INPUT'
  | 'SANAD_UNKNOWN_CHUNK'
  | 'SANAD_QUOTE_NOT_FOUND'
  | 'SANAD_DUPLICATE_EVIDENCE';

/** Messages contain no document text, quotes, or untrusted field values. */
export class SanadVerifyError extends Error {
  constructor(readonly code: SanadVerifyErrorCode) {
    super(code);
    this.name = 'SanadVerifyError';
  }
}

const isUnicodeText = (value: string): boolean => !/\p{Surrogate}/u.test(value);
const textSchema = z.string().max(1_000_000).refine(isUnicodeText);

export interface ClaimCandidate {
  id: string;
  text: string;
  /** Unicode code-point offsets into the input, not UTF-16 code units. */
  charStart: number;
  charEnd: number;
  method: 'heuristic-v1';
  reviewStatus: 'needs_human_review';
}

const researchSubject =
  /\b(?:stud(?:y|ies)|research|evidence|results?|participants?|samples?|treatment|patients?|data|hypothes[ie]s)\b|دراس|نتائج|النتيجة|الأدلة|الادلة|البحث|المشاركين|العينة|العينه|العلاج|المرضى|البيانات|الفرضية|الفرضيه/iu;
const researchPredicate =
  /\b(?:show(?:s|ed)?|found|find(?:s|ings)?|suggest(?:s|ed)?|increas\w*|reduc\w*|decreas\w*|associat\w*|correlat\w*|predict\w*|significant\w*|improv\w*|caus\w*|affect\w*)\b|أظهر|اظهر|تظهر|أشار|اشار|تشير|يرتبط|ترتبط|ارتباط|ازداد|انخفض|يزيد|تزيد|يقلل|تقلل|تحسن|دلالة|دلاله|تأثير|تاثير|يؤثر|تؤثر/iu;
const quantitative = /[\p{N}].*(?:%|٪)|(?:%|٪).*[\p{N}]/u;

/**
 * Extracts possible research assertions for human review, without a model.
 *
 * This is a deliberately incomplete heuristic: it cannot determine scientific
 * truth, entailment, negation, causality, study quality, or whether a claim is
 * original. It can miss claims and include ordinary prose. Intl.Segmenter may
 * segment abbreviations differently across ICU versions. Questions and sentences
 * without a research cue plus predicate/percentage are omitted. No candidate is
 * labelled supported, verified, or scientifically established.
 */
export function extractClaimCandidates(input: unknown): ClaimCandidate[] {
  const parsed = textSchema.safeParse(input);
  if (!parsed.success) throw new SanadVerifyError('SANAD_VERIFY_INVALID_INPUT');
  const text = parsed.data;
  const candidates: ClaimCandidate[] = [];
  const segmenter = new Intl.Segmenter('ar', { granularity: 'sentence' });
  let charOffset = 0;

  for (const { segment } of segmenter.segment(text)) {
    const points = Array.from(segment);
    let start = 0;
    let end = points.length;
    while (start < end && /\s/u.test(points[start] ?? '')) start += 1;
    while (end > start && /\s/u.test(points[end - 1] ?? '')) end -= 1;
    const sentence = points.slice(start, end).join('');
    if (
      sentence.length > 0 &&
      !/[?؟][\s"'»”’)]*$/u.test(sentence) &&
      researchSubject.test(sentence) &&
      (researchPredicate.test(sentence) || quantitative.test(sentence))
    ) {
      const charStart = charOffset + start;
      const charEnd = charOffset + end;
      candidates.push({
        id: `claim-${charStart}-${charEnd}`,
        text: sentence,
        charStart,
        charEnd,
        method: 'heuristic-v1',
        reviewStatus: 'needs_human_review',
      });
    }
    charOffset += points.length;
  }
  return candidates;
}

const page = z.number().int().positive().nullable();
const evidenceSchema = z
  .object({
    chunkId: z.uuid(),
    sourceId: z.uuid(),
    content: z.string().min(1).max(1_000_000).refine(isUnicodeText),
    kind: z.enum(['full_text', 'abstract']),
    fileId: z.uuid().nullable(),
    fileSha256: z
      .string()
      .length(64)
      .regex(/^[a-f0-9]{64}$/u)
      .nullable(),
    pageStart: page,
    pageEnd: page,
    sourceVerificationStatus: z.enum(['unverified', 'verified', 'mismatch', 'not_found']),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (
      (value.pageStart === null) !== (value.pageEnd === null) ||
      (value.pageStart !== null && value.pageEnd !== null && value.pageEnd < value.pageStart)
    ) {
      ctx.addIssue({ code: 'custom', path: ['pageEnd'], message: 'Invalid stored page range.' });
    }
    if (value.kind === 'abstract' && (value.pageStart !== null || value.fileId !== null)) {
      ctx.addIssue({ code: 'custom', path: ['kind'], message: 'Abstracts have no file or page.' });
    }
    if (value.fileId === null && value.fileSha256 !== null) {
      ctx.addIssue({ code: 'custom', path: ['fileSha256'], message: 'Hash requires a file.' });
    }
  });

const quotationRequestSchema = z
  .object({ chunkId: z.uuid(), quote: z.string().min(1).max(20_000).refine(isUnicodeText) })
  .strict();

/** Must come from an authorized, project-scoped database retrieval, never model output. */
export type QuotationEvidence = z.infer<typeof evidenceSchema>;
export type QuotationRequest = z.infer<typeof quotationRequestSchema>;

export interface QuotationMatch {
  status: 'exact_quote_match';
  reviewStatus: 'needs_human_review';
  method: 'verbatim-v1';
  chunkId: string;
  sourceId: string;
  fileId: string | null;
  fileSha256: string | null;
  kind: QuotationEvidence['kind'];
  sourceVerificationStatus: QuotationEvidence['sourceVerificationStatus'];
  pageStart: number | null;
  pageEnd: number | null;
  quote: string;
  /** First exact occurrence, in Unicode code points relative to chunk content. */
  charStart: number;
  charEnd: number;
}

/**
 * Binds a verbatim quotation to an allow-listed stored passage. This proves only
 * that the exact string occurs in that passage; it does not prove that the source
 * or quote scientifically supports any claim. Pages and version hashes are copied
 * only from stored evidence. The request cannot supply citations or metadata.
 *
 * No normalization is used: changing Arabic diacritics, whitespace, punctuation,
 * or word order fails the match. Untrusted document instructions remain text.
 */
export function verifyQuotation(request: unknown, allowedEvidence: unknown): QuotationMatch {
  const parsedRequest = quotationRequestSchema.safeParse(request);
  const parsedEvidence = z.array(evidenceSchema).max(200).safeParse(allowedEvidence);
  if (!parsedRequest.success || !parsedEvidence.success) {
    throw new SanadVerifyError('SANAD_VERIFY_INVALID_INPUT');
  }
  const seen = new Set<string>();
  for (const evidence of parsedEvidence.data) {
    if (seen.has(evidence.chunkId)) throw new SanadVerifyError('SANAD_DUPLICATE_EVIDENCE');
    seen.add(evidence.chunkId);
  }
  const evidence = parsedEvidence.data.find((item) => item.chunkId === parsedRequest.data.chunkId);
  if (evidence === undefined) throw new SanadVerifyError('SANAD_UNKNOWN_CHUNK');
  const { quote } = parsedRequest.data;
  if (quote.trim().length === 0) throw new SanadVerifyError('SANAD_VERIFY_INVALID_INPUT');
  const utf16Start = evidence.content.indexOf(quote);
  if (utf16Start < 0) throw new SanadVerifyError('SANAD_QUOTE_NOT_FOUND');
  const charStart = Array.from(evidence.content.slice(0, utf16Start)).length;
  return {
    status: 'exact_quote_match',
    reviewStatus: 'needs_human_review',
    method: 'verbatim-v1',
    chunkId: evidence.chunkId,
    sourceId: evidence.sourceId,
    fileId: evidence.fileId,
    fileSha256: evidence.fileSha256,
    kind: evidence.kind,
    sourceVerificationStatus: evidence.sourceVerificationStatus,
    pageStart: evidence.pageStart,
    pageEnd: evidence.pageEnd,
    quote,
    charStart,
    charEnd: charStart + Array.from(quote).length,
  };
}
