import { describe, expect, it } from 'vitest';

import { bindSanadAnswer } from '../src/sanad/answer';
import type { QuotationEvidence } from '../src/sanad/verify';

// Software fixtures, not scientific claims or live model responses.
const evidence: QuotationEvidence = {
  chunkId: 'bc85c004-aee8-4da5-989a-e22ac276bc46',
  sourceId: '9e03a63b-7ddd-451d-8f5e-aa7c176514ba',
  fileId: '33b35b23-3ee0-4ef2-ae47-750b7eaab6c8',
  fileSha256: 'a'.repeat(64),
  content: '🧪 The study found an association. أظهرت الدراسة ارتباطاً.',
  kind: 'full_text',
  pageStart: 7,
  pageEnd: 7,
  sourceVerificationStatus: 'unverified',
};
const citation = { chunkId: evidence.chunkId, quote: 'أظهرت الدراسة ارتباطاً.' };
const statement = {
  text: 'A software test statement.',
  classification: 'evidence_linked',
  citations: [citation],
};

describe('structured SANAD assistant answer boundary', () => {
  it('binds every citation to stored metadata with explicit review status', () => {
    const result = bindSanadAnswer({ statements: [statement] }, [evidence]);
    expect(result.reviewStatus).toBe('needs_human_review');
    expect(result.statements[0]).toMatchObject({
      text: statement.text,
      classification: 'evidence_linked',
      reviewStatus: 'needs_human_review',
      citations: [
        {
          sourceId: evidence.sourceId,
          fileId: evidence.fileId,
          fileSha256: evidence.fileSha256,
          pageStart: 7,
          pageEnd: 7,
          sourceVerificationStatus: 'unverified',
          reviewStatus: 'needs_human_review',
        },
      ],
    });
    expect(result.statements[0]).not.toHaveProperty('supported');
  });

  it.each(['inference', 'hypothesis', 'unsupported'])(
    'allows an uncited statement only with an explicit %s label',
    (classification) => {
      expect(
        bindSanadAnswer({ statements: [{ ...statement, classification, citations: [] }] }, [])
          .statements[0]?.classification,
      ).toBe(classification);
    },
  );

  it('permits distinct exact quotations from the same stored passage', () => {
    const result = bindSanadAnswer(
      {
        statements: [
          {
            ...statement,
            citations: [citation, { ...citation, quote: 'The study found an association.' }],
          },
        ],
      },
      [evidence],
    );
    expect(result.statements[0]?.citations).toHaveLength(2);
  });

  it.each([
    { ...statement, citations: [] },
    { text: statement.text, citations: [citation] },
    { ...statement, classification: 'verified' },
    { ...statement, classification: 'unsupported' },
    { ...statement, citations: [citation, citation] },
    { ...statement, citations: [{ ...citation, pageStart: 1 }] },
    { ...statement, citations: [{ ...citation, sourceId: evidence.sourceId }] },
    { ...statement, text: '  ' },
  ])('rejects missing labels, invented metadata and ambiguous citations (%#)', (invalid) => {
    expect(() => bindSanadAnswer({ statements: [invalid] }, [evidence])).toThrow(
      'SANAD_VERIFY_INVALID_INPUT',
    );
  });

  it('rejects fabricated chunks and altered quotes rather than returning partial answers', () => {
    expect(() =>
      bindSanadAnswer(
        {
          statements: [
            {
              ...statement,
              citations: [{ ...citation, chunkId: 'fc2c39f0-e058-4d19-83dd-efdc4f1b0392' }],
            },
          ],
        },
        [evidence],
      ),
    ).toThrow('SANAD_UNKNOWN_CHUNK');
    expect(() =>
      bindSanadAnswer(
        {
          statements: [
            statement,
            { ...statement, citations: [{ ...citation, quote: 'fabricated research content' }] },
          ],
        },
        [evidence],
      ),
    ).toThrow(/^SANAD_QUOTE_NOT_FOUND$/u);
  });

  it('does not permit model prose outside the validated statement collection', () => {
    expect(() =>
      bindSanadAnswer({ statements: [statement], summary: 'unvalidated claim' }, [evidence]),
    ).toThrow('SANAD_VERIFY_INVALID_INPUT');
    expect(() => bindSanadAnswer({ statements: [] }, [evidence])).toThrow(
      'SANAD_VERIFY_INVALID_INPUT',
    );
  });

  it('validates duplicate and malformed allowed evidence even for an uncited answer', () => {
    const input = { statements: [{ ...statement, classification: 'unsupported', citations: [] }] };
    expect(() => bindSanadAnswer(input, [evidence, evidence])).toThrow('SANAD_DUPLICATE_EVIDENCE');
    expect(() => bindSanadAnswer(input, [{ ...evidence, pageStart: 9 }])).toThrow(
      'SANAD_VERIFY_INVALID_INPUT',
    );
  });

  it('retains the no-page rule for abstract-only citations', () => {
    const abstract = {
      ...evidence,
      kind: 'abstract',
      fileId: null,
      fileSha256: null,
      pageStart: null,
      pageEnd: null,
    };
    expect(
      bindSanadAnswer({ statements: [statement] }, [abstract]).statements[0]?.citations[0],
    ).toMatchObject({ kind: 'abstract', fileId: null, pageStart: null, pageEnd: null });
  });

  it('does not mistake literal citation matching for semantic support', () => {
    const result = bindSanadAnswer(
      { statements: [{ ...statement, text: 'An unrelated claim.' }] },
      [evidence],
    );
    expect(result.statements[0]?.citations[0]?.status).toBe('exact_quote_match');
    expect(result.statements[0]?.reviewStatus).toBe('needs_human_review');
  });
});
