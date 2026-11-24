import { generateText, Output } from 'ai';
import type { LanguageModel } from 'ai';
import { z } from 'zod';

import {
  EVIDENCE_JUDGE_PROMPT_VERSION,
  evidenceJudgeSystemPrompt,
  evidenceJudgeUserPrompt,
} from '../prompts/evidence-judge';
import { SanadVerifyError, verifyQuotation } from '../sanad/verify';

import type { AnswerPassage } from './grounded-answer';
import { classifyAiError, MAX_ANSWER_PASSAGES, passageHandles } from './grounded-answer';

export const evidenceJudgeOutputSchema = z.object({
  judgements: z
    .array(
      z.object({
        passage: z.string().max(8),
        verdict: z.enum(['supports', 'contradicts', 'insufficient']),
        quote: z.string().max(1200),
      }),
    )
    .max(MAX_ANSWER_PASSAGES),
});

export type EvidenceJudgeOutput = z.infer<typeof evidenceJudgeOutputSchema>;

export interface EvidenceJudgement {
  chunkId: string;
  sourceId: string;
  verdict: 'supports' | 'contradicts' | 'insufficient';
  /** Verbatim span of the stored passage (empty when insufficient). */
  quote: string;
  pageStart: number | null;
  pageEnd: number | null;
  kind: 'full_text' | 'abstract';
}

export type EvidenceStrength = 'strong' | 'moderate' | 'limited' | 'none' | 'contested';

export interface ClaimVerification {
  method: 'model-judgement-v1';
  /** A model's reading of the passages: a researcher must review it before relying on it. */
  reviewStatus: 'needs_human_review';
  promptVersion: string;
  judgements: EvidenceJudgement[];
  conflict: boolean;
  strength: EvidenceStrength;
  diagnostics: { unknownPassages: number; unverifiedQuotes: number };
}

/**
 * Deterministic summary of judgements (no model): a conflict is at least one
 * supporting and one contradicting passage. Strength counts independent sources
 * (distinct sourceId) with a verified supporting quote from the full text; abstracts
 * alone are "limited" because they cannot be checked against a page.
 */
export function summariseEvidence(judgements: readonly EvidenceJudgement[]): {
  conflict: boolean;
  strength: EvidenceStrength;
} {
  const supporting = judgements.filter((j) => j.verdict === 'supports');
  const contradicting = judgements.filter((j) => j.verdict === 'contradicts');
  const conflict = supporting.length > 0 && contradicting.length > 0;
  if (conflict) return { conflict, strength: 'contested' };
  const fullTextSources = new Set(
    supporting.filter((j) => j.kind === 'full_text').map((j) => j.sourceId),
  );
  if (fullTextSources.size >= 2) return { conflict, strength: 'strong' };
  if (fullTextSources.size === 1) return { conflict, strength: 'moderate' };
  if (supporting.length > 0) return { conflict, strength: 'limited' };
  return { conflict, strength: 'none' };
}

/** Grounds the model's judgements: known passages only, verbatim quotes only. */
export function groundJudgements(
  output: EvidenceJudgeOutput,
  passages: readonly AnswerPassage[],
): Omit<ClaimVerification, 'method' | 'reviewStatus' | 'promptVersion'> {
  const handles = passageHandles(passages);
  const allowed = passages.map(({ sourceTitle: _title, ...evidence }) => evidence);
  const diagnostics = { unknownPassages: 0, unverifiedQuotes: 0 };
  const byChunk = new Map<string, EvidenceJudgement>();
  for (const item of output.judgements) {
    const passage = handles.get(item.passage.trim().toUpperCase());
    if (passage === undefined) {
      diagnostics.unknownPassages += 1;
      continue;
    }
    let verdict = item.verdict;
    let quote = '';
    if (verdict !== 'insufficient') {
      try {
        quote = verifyQuotation({ chunkId: passage.chunkId, quote: item.quote }, allowed).quote;
      } catch (error) {
        if (!(error instanceof SanadVerifyError)) throw error;
        // A verdict without a verbatim span is not evidence either way.
        diagnostics.unverifiedQuotes += 1;
        verdict = 'insufficient';
      }
    }
    byChunk.set(passage.chunkId, {
      chunkId: passage.chunkId,
      sourceId: passage.sourceId,
      verdict,
      quote,
      pageStart: passage.pageStart,
      pageEnd: passage.pageEnd,
      kind: passage.kind,
    });
  }
  const judgements = [...byChunk.values()];
  return { judgements, ...summariseEvidence(judgements), diagnostics };
}

export async function verifyClaimAgainstPassages(input: {
  model: LanguageModel;
  claim: string;
  passages: readonly AnswerPassage[];
  timeoutMs?: number;
}): Promise<{
  verification: ClaimVerification;
  usage: { inputTokens: number | null; outputTokens: number | null };
}> {
  const claim = z.string().trim().min(1).max(2000).parse(input.claim);
  const passages = input.passages.slice(0, MAX_ANSWER_PASSAGES);
  const base = {
    method: 'model-judgement-v1' as const,
    reviewStatus: 'needs_human_review' as const,
    promptVersion: EVIDENCE_JUDGE_PROMPT_VERSION,
  };
  if (passages.length === 0) {
    return {
      verification: {
        ...base,
        judgements: [],
        conflict: false,
        strength: 'none',
        diagnostics: { unknownPassages: 0, unverifiedQuotes: 0 },
      },
      usage: { inputTokens: 0, outputTokens: 0 },
    };
  }
  const handles = [...passageHandles(passages)].map(([handle, passage]) => ({
    handle,
    title: passage.sourceTitle,
    content: passage.content,
  }));
  try {
    const result = await generateText({
      model: input.model,
      instructions: evidenceJudgeSystemPrompt(),
      prompt: evidenceJudgeUserPrompt(claim, handles),
      output: Output.object({ schema: evidenceJudgeOutputSchema }),
      temperature: 0,
      maxRetries: 2,
      timeout: input.timeoutMs ?? 90_000,
    });
    return {
      verification: { ...base, ...groundJudgements(result.output, passages) },
      usage: {
        inputTokens: result.usage.inputTokens ?? null,
        outputTokens: result.usage.outputTokens ?? null,
      },
    };
  } catch (error) {
    throw classifyAiError(error);
  }
}
