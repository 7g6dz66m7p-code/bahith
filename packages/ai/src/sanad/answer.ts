import { z } from 'zod';

import type { QuotationMatch } from './verify';
import { parseQuotationEvidence, SanadVerifyError, verifyQuotation } from './verify';

const statementSchema = z.strictObject({
  text: z
    .string()
    .trim()
    .min(1)
    .max(20_000)
    .refine((value) => !/\p{Surrogate}/u.test(value)),
  classification: z.enum(['evidence_linked', 'inference', 'hypothesis', 'unsupported']),
  citations: z
    .array(
      z.strictObject({
        chunkId: z.uuid(),
        quote: z.string().min(1).max(20_000),
      }),
    )
    .max(10),
});

const answerSchema = z
  .strictObject({ statements: z.array(statementSchema).min(1).max(100) })
  .superRefine((answer, ctx) => {
    if (
      answer.statements.reduce((length, statement) => length + statement.text.length, 0) > 100_000
    )
      ctx.addIssue({ code: 'custom', message: 'Answer exceeds the text limit.' });
    for (const [index, statement] of answer.statements.entries()) {
      if (
        (statement.classification === 'evidence_linked' && statement.citations.length === 0) ||
        (statement.classification === 'unsupported' && statement.citations.length > 0) ||
        new Set(
          statement.citations.map((citation) => JSON.stringify([citation.chunkId, citation.quote])),
        ).size !== statement.citations.length
      ) {
        ctx.addIssue({
          code: 'custom',
          path: ['statements', index, 'citations'],
          message: 'Invalid citation assignment.',
        });
      }
    }
  });

export interface SanadAnswerStatement {
  text: string;
  /** A presentation label, never a scientific entailment or truth verdict. */
  classification: z.infer<typeof statementSchema>['classification'];
  reviewStatus: 'needs_human_review';
  citations: QuotationMatch[];
}

/**
 * Validates untrusted structured assistant output before it can become an answer.
 * Every statement has an explicit evidence/inference/hypothesis/unsupported label.
 * Citation pages, identities and hashes come only from authorized stored passages;
 * the assistant may supply only an allow-listed chunk id and a verbatim quote.
 *
 * This checks structural grounding and literal presence, not semantic entailment:
 * an unrelated but exact quote remains subject to human review. Live model calls,
 * scientific support scoring and persistence are separate responsibilities.
 */
export function bindSanadAnswer(
  input: unknown,
  allowedEvidence: unknown,
): { statements: SanadAnswerStatement[]; reviewStatus: 'needs_human_review' } {
  const parsed = answerSchema.safeParse(input);
  if (!parsed.success) throw new SanadVerifyError('SANAD_VERIFY_INVALID_INPUT');
  // Validate the trusted projection even for an answer with no citation. An empty
  // citation array must not be a way to bypass malformed evidence validation.
  const evidence = parseQuotationEvidence(allowedEvidence);
  return {
    reviewStatus: 'needs_human_review',
    statements: parsed.data.statements.map((statement) => ({
      text: statement.text,
      classification: statement.classification,
      reviewStatus: 'needs_human_review',
      citations: statement.citations.map((citation) =>
        verifyQuotation(
          citation,
          evidence.has(citation.chunkId) ? [evidence.get(citation.chunkId)] : [],
        ),
      ),
    })),
  };
}
