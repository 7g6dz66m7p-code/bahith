import { APICallError, generateText, NoObjectGeneratedError, Output, RetryError } from 'ai';
import type { LanguageModel } from 'ai';
import { z } from 'zod';

import {
  GROUNDED_ANSWER_PROMPT_VERSION,
  groundedAnswerSystemPrompt,
  groundedAnswerUserPrompt,
} from '../prompts/grounded-answer';
import { SanadVerifyError, verifyQuotation } from '../sanad/verify';
import type { QuotationEvidence } from '../sanad/verify';

export const MAX_ANSWER_PASSAGES = 12;

/** What the model must return. Passage ids are short handles, never database ids. */
export const groundedAnswerOutputSchema = z.object({
  abstain: z.boolean(),
  sentences: z
    .array(
      z.object({
        text: z.string().min(1).max(2000),
        kind: z.enum(['supported', 'inference']),
        evidence: z
          .array(z.object({ passage: z.string().max(8), quote: z.string().min(1).max(1200) }))
          .max(4),
      }),
    )
    .max(12),
});

export type GroundedAnswerOutput = z.infer<typeof groundedAnswerOutputSchema>;

export interface AnswerPassage extends QuotationEvidence {
  sourceTitle: string;
}

export interface GroundedEvidence {
  chunkId: string;
  sourceId: string;
  fileId: string | null;
  kind: QuotationEvidence['kind'];
  /** From the stored passage only; null for an abstract (cited without a page). */
  pageStart: number | null;
  pageEnd: number | null;
  quote: string;
  charStart: number;
  charEnd: number;
}

export interface GroundedSentence {
  text: string;
  /** "unsupported": the model claimed support but no quote could be verified. */
  support: 'supported' | 'inference' | 'unsupported';
  evidence: GroundedEvidence[];
}

export interface GroundedAnswer {
  status: 'answered' | 'abstained';
  sentences: GroundedSentence[];
  diagnostics: {
    /** Passage ids the model cited that were not given to it (rejected). */
    unknownPassages: number;
    /** Quotes not found verbatim in the cited passage (dropped). */
    unverifiedQuotes: number;
    /** "supported" sentences left without any verified evidence. */
    downgraded: number;
    /** Reference or page fragments the model wrote into sentences (removed). */
    strippedCitations: number;
  };
}

/**
 * References and page numbers come from stored records only (CLAUDE.md rule 9), so any
 * the model writes itself are removed from the sentence: author–year parentheses
 * "(Smith, 2020, p. 4)", "(الأحمد، ٢٠١٩)", and bare page markers "p. 12", "ص ١٢".
 */
const CITATION_PATTERNS = [
  /\s*[(（[][^()（）[\]]{0,120}?(?:1[5-9]|20)\d{2}[a-z]?[^()（）[\]]{0,60}?[)）\]]/gu,
  /\s*[(（[][^()（）[\]]{0,120}?[١][٥-٩][٠-٩]{2}[^()（）[\]]{0,60}?[)）\]]/gu,
  /\s*[(（[][^()（）[\]]{0,120}?٢٠[٠-٩]{2}[^()（）[\]]{0,60}?[)）\]]/gu,
  /\s*\b(?:pp?\.|pages?)\s*[0-9]+(?:\s*[-–]\s*[0-9]+)?/giu,
  /\s*(?:ص|صفحة|الصفحة|صص)\.?\s*[0-9٠-٩]+(?:\s*[-–]\s*[0-9٠-٩]+)?/gu,
];

export function stripModelCitations(text: string): { text: string; removed: number } {
  let removed = 0;
  let out = text;
  for (const pattern of CITATION_PATTERNS) {
    out = out.replace(pattern, () => {
      removed += 1;
      return '';
    });
  }
  return { text: out.replace(/\s{2,}/gu, ' ').trim(), removed };
}

/** Short, stable handles for the passages sent to the model: P1, P2, … */
export function passageHandles(passages: readonly AnswerPassage[]): Map<string, AnswerPassage> {
  return new Map(passages.map((passage, index) => [`P${String(index + 1)}`, passage]));
}

/**
 * Turns model output into an answer the platform can show. Deterministic: every cited
 * passage must be one that was sent, every quote must occur verbatim in it, and pages
 * come only from the stored passage. Nothing the model writes becomes a reference.
 */
export function groundAnswer(
  output: GroundedAnswerOutput,
  passages: readonly AnswerPassage[],
): GroundedAnswer {
  const handles = passageHandles(passages);
  const allowed = passages.map(({ sourceTitle: _title, ...evidence }) => evidence);
  const diagnostics = {
    unknownPassages: 0,
    unverifiedQuotes: 0,
    downgraded: 0,
    strippedCitations: 0,
  };
  if (output.abstain) return { status: 'abstained', sentences: [], diagnostics };

  const sentences: GroundedSentence[] = [];
  for (const sentence of output.sentences) {
    const evidence: GroundedEvidence[] = [];
    for (const item of sentence.evidence) {
      const passage = handles.get(item.passage.trim().toUpperCase());
      if (passage === undefined) {
        diagnostics.unknownPassages += 1;
        continue;
      }
      try {
        const match = verifyQuotation({ chunkId: passage.chunkId, quote: item.quote }, allowed);
        if (!evidence.some((e) => e.chunkId === match.chunkId && e.charStart === match.charStart)) {
          evidence.push({
            chunkId: match.chunkId,
            sourceId: match.sourceId,
            fileId: match.fileId,
            kind: match.kind,
            pageStart: match.pageStart,
            pageEnd: match.pageEnd,
            quote: match.quote,
            charStart: match.charStart,
            charEnd: match.charEnd,
          });
        }
      } catch (error) {
        if (!(error instanceof SanadVerifyError)) throw error;
        diagnostics.unverifiedQuotes += 1;
      }
    }
    let support: GroundedSentence['support'] = sentence.kind;
    if (sentence.kind === 'supported' && evidence.length === 0) {
      support = 'unsupported';
      diagnostics.downgraded += 1;
    }
    const cleaned = stripModelCitations(sentence.text);
    diagnostics.strippedCitations += cleaned.removed;
    if (cleaned.text === '') continue;
    sentences.push({ text: cleaned.text, support, evidence });
  }
  return { status: sentences.length === 0 ? 'abstained' : 'answered', sentences, diagnostics };
}

export type AiCallErrorCode =
  | 'AI_TIMEOUT'
  | 'AI_PROVIDER_ERROR'
  | 'AI_PROVIDER_QUOTA'
  | 'AI_PROVIDER_AUTH'
  | 'AI_OUTPUT_INVALID';

/** Classified model-call failure. Never carries prompt, passage or answer text. */
export class AiCallError extends Error {
  constructor(
    readonly code: AiCallErrorCode,
    readonly status?: number,
  ) {
    super(code);
    this.name = 'AiCallError';
  }
}

/**
 * Maps AI SDK failures (also when wrapped in a RetryError after retries) to stable codes.
 * The provider's message and body are never kept: they can echo request content.
 */
export function classifyAiError(error: unknown): unknown {
  const cause = RetryError.isInstance(error) ? error.lastError : error;
  if (cause instanceof AiCallError) return cause;
  if (NoObjectGeneratedError.isInstance(cause)) return new AiCallError('AI_OUTPUT_INVALID');
  if (APICallError.isInstance(cause)) {
    const status = cause.statusCode;
    const body = typeof cause.responseBody === 'string' ? cause.responseBody : '';
    if (/insufficient_quota|credit_balance_exhausted|billing/u.test(body) || status === 402) {
      return new AiCallError('AI_PROVIDER_QUOTA', status);
    }
    if (status === 401 || status === 403) return new AiCallError('AI_PROVIDER_AUTH', status);
    return new AiCallError('AI_PROVIDER_ERROR', status);
  }
  if (cause instanceof Error && (cause.name === 'AbortError' || cause.name === 'TimeoutError')) {
    return new AiCallError('AI_TIMEOUT');
  }
  return error;
}

export interface GroundedAnswerRun {
  answer: GroundedAnswer;
  promptVersion: string;
  usage: { inputTokens: number | null; outputTokens: number | null };
  latencyMs: number;
}

/**
 * Asks the model, then grounds its output. Without passages there is nothing to ground
 * an answer on: it abstains without calling the model.
 */
export async function runGroundedAnswer(input: {
  model: LanguageModel;
  question: string;
  language: 'ar' | 'en';
  passages: readonly AnswerPassage[];
  timeoutMs?: number;
  maxRetries?: number;
}): Promise<GroundedAnswerRun> {
  const question = z.string().trim().min(1).max(2000).parse(input.question);
  const passages = input.passages.slice(0, MAX_ANSWER_PASSAGES);
  const promptVersion = GROUNDED_ANSWER_PROMPT_VERSION;
  if (passages.length === 0) {
    return {
      answer: {
        status: 'abstained',
        sentences: [],
        diagnostics: {
          unknownPassages: 0,
          unverifiedQuotes: 0,
          downgraded: 0,
          strippedCitations: 0,
        },
      },
      promptVersion,
      usage: { inputTokens: 0, outputTokens: 0 },
      latencyMs: 0,
    };
  }
  const handles = [...passageHandles(passages)].map(([handle, passage]) => ({
    handle,
    title: passage.sourceTitle,
    content: passage.content,
  }));
  const started = Date.now();
  try {
    const result = await generateText({
      model: input.model,
      instructions: groundedAnswerSystemPrompt(input.language),
      prompt: groundedAnswerUserPrompt(question, handles),
      output: Output.object({ schema: groundedAnswerOutputSchema }),
      temperature: 0,
      maxRetries: input.maxRetries ?? 2,
      timeout: input.timeoutMs ?? 90_000,
    });
    return {
      answer: groundAnswer(result.output, passages),
      promptVersion,
      usage: {
        inputTokens: result.usage.inputTokens ?? null,
        outputTokens: result.usage.outputTokens ?? null,
      },
      latencyMs: Date.now() - started,
    };
  } catch (error) {
    throw classifyAiError(error);
  }
}
