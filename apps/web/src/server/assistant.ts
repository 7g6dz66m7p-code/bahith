import type { AnswerPassage, GroundedAnswer } from '@bahith/ai';
import {
  AiCallError,
  AiConfigError,
  embedTexts,
  EVIDENCE_JUDGE_PROMPT_VERSION,
  verifyClaimAgainstPassages,
  loadEmbeddingModelRef,
  resolveEmbeddingModel,
  AiProviderError,
  loadChatModelRef,
  MAX_ANSWER_PASSAGES,
  resolveLanguageModel,
  runGroundedAnswer,
} from '@bahith/ai';
import type { Database, SanadProjectContext } from '@bahith/db';
import {
  AssistantError,
  finishAssistantRun,
  getProjectAiConsent,
  retrieve,
  saveAssistantExchange,
  startAssistantRun,
} from '@bahith/db';

/** The configured embedding model, or null (lexical-only retrieval). */
function embeddingModelFromEnv() {
  try {
    const ref = loadEmbeddingModelRef(process.env);
    if (ref === null) return null;
    return { model: resolveEmbeddingModel(ref, process.env), modelId: ref.model };
  } catch (error) {
    if (error instanceof AiConfigError || error instanceof AiProviderError) {
      throw new AssistantRequestError('AI_NOT_CONFIGURED', 503);
    }
    throw error;
  }
}

/** The configured chat model as "provider:model", or null — shown to the user before consent. */
export function configuredChatModel(): string | null {
  try {
    const ref = loadChatModelRef(process.env);
    return `${ref.provider}:${ref.model}`;
  } catch {
    return null;
  }
}

export interface AssistantEvidence {
  chunkId: string;
  sourceId: string;
  sourceTitle: string;
  fileId: string | null;
  kind: 'full_text' | 'abstract';
  pageStart: number | null;
  pageEnd: number | null;
  quote: string;
}

export interface AssistantReply {
  status: 'answered' | 'abstained';
  /** Why it abstained without asking the model (no passage matched the question). */
  reason: 'NO_EVIDENCE' | null;
  conversationId: string | null;
  model: string;
  sentences: {
    text: string;
    support: 'supported' | 'inference' | 'unsupported';
    evidence: AssistantEvidence[];
  }[];
  diagnostics: GroundedAnswer['diagnostics'];
}

/** A failure the client can explain; the code is shown, never internal detail. */
export class AssistantRequestError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
  ) {
    super(code);
  }
}

const STATUS: Record<string, number> = {
  AI_CONSENT_REQUIRED: 409,
  AI_QUOTA_NOT_CONFIGURED: 503,
  AI_QUOTA_EXCEEDED: 429,
};

/**
 * Consent → model configuration → project-scoped retrieval → quota → model → grounding
 * → stored claims. Only retrieved passages of this project are sent to the provider,
 * and only after consent. Logs nothing about the question or the passages.
 */
export async function askAssistant(
  database: Database,
  context: SanadProjectContext,
  input: { question: string; conversationId: string | null; language: 'ar' | 'en' },
): Promise<AssistantReply> {
  if (!(await getProjectAiConsent(database, context)).enabled) {
    throw new AssistantRequestError('AI_CONSENT_REQUIRED', 409);
  }
  let model;
  let label: string;
  try {
    const ref = loadChatModelRef(process.env);
    model = resolveLanguageModel(ref, process.env);
    label = `${ref.provider}:${ref.model}`;
  } catch (error) {
    if (error instanceof AiConfigError) throw new AssistantRequestError('AI_NOT_CONFIGURED', 503);
    if (error instanceof AiProviderError) throw new AssistantRequestError(error.code, 503);
    throw error;
  }

  const startRun = async (): Promise<string> => {
    try {
      return (
        await startAssistantRun(database, context, {
          agent: 'grounded-answer',
          promptVersion: 'grounded-answer@1',
          provider: label.slice(0, label.indexOf(':')),
          model: label.slice(label.indexOf(':') + 1),
        })
      ).runId;
    } catch (error) {
      if (error instanceof AssistantError && error.code in STATUS) {
        throw new AssistantRequestError(error.code, STATUS[error.code] ?? 400);
      }
      throw error;
    }
  };
  const fail = async (id: string, error: unknown): Promise<never> => {
    const code = error instanceof AiCallError ? error.code : 'AI_PROVIDER_ERROR';
    await finishAssistantRun(database, context, id, {
      status: 'failed',
      inputTokens: null,
      outputTokens: null,
      latencyMs: null,
      errorCode: code,
    });
    throw new AssistantRequestError(
      code,
      code === 'AI_TIMEOUT'
        ? 504
        : code === 'AI_PROVIDER_QUOTA' || code === 'AI_PROVIDER_AUTH'
          ? 503
          : 502,
    );
  };

  // Semantic search when an embedding model is configured: the question is embedded
  // inside the same counted run (consent and quota are checked before that call).
  let runId: string | null = null;
  let queryEmbedding: { model: string; values: number[] } | undefined;
  const embedding = embeddingModelFromEnv();
  if (embedding !== null) {
    runId = await startRun();
    try {
      const batch = await embedTexts({
        model: embedding.model,
        modelId: embedding.modelId,
        values: [input.question],
      });
      const values = batch.vectors[0];
      if (values !== undefined) queryEmbedding = { model: embedding.modelId, values };
    } catch (error) {
      return fail(runId, error);
    }
  }

  const retrieved = await retrieve(database, {
    ...context,
    query: input.question,
    limit: MAX_ANSWER_PASSAGES,
    ...(queryEmbedding === undefined ? {} : { queryEmbedding }),
  });
  const passages: AnswerPassage[] = retrieved.results.map((item) => ({
    chunkId: item.chunkId,
    sourceId: item.sourceId,
    content: item.content,
    kind: item.kind,
    fileId: item.fileId,
    fileSha256: item.fileSha256,
    pageStart: item.pageStart,
    pageEnd: item.pageEnd,
    sourceVerificationStatus: item.verificationStatus,
    sourceTitle: item.sourceTitle,
  }));
  const empty = { unknownPassages: 0, unverifiedQuotes: 0, downgraded: 0, strippedCitations: 0 };
  if (passages.length === 0) {
    if (runId !== null) {
      await finishAssistantRun(database, context, runId, {
        status: 'succeeded',
        inputTokens: null,
        outputTokens: 0,
        latencyMs: null,
        errorCode: null,
      });
    }
    return {
      status: 'abstained',
      reason: 'NO_EVIDENCE',
      conversationId: input.conversationId,
      model: label,
      sentences: [],
      diagnostics: empty,
    };
  }
  runId ??= await startRun();

  let run;
  try {
    run = await runGroundedAnswer({
      model,
      question: input.question,
      language: input.language,
      passages,
    });
  } catch (error) {
    return fail(runId, error);
  }
  await finishAssistantRun(database, context, runId, {
    status: 'succeeded',
    inputTokens: run.usage.inputTokens,
    outputTokens: run.usage.outputTokens,
    latencyMs: run.latencyMs,
    errorCode: null,
  });
  const saved = await saveAssistantExchange(database, context, {
    conversationId: input.conversationId,
    runId,
    question: input.question,
    answer: {
      status: run.answer.status,
      sentences: run.answer.sentences.map((sentence) => ({
        text: sentence.text,
        support: sentence.support,
        evidence: sentence.evidence.map((item) => ({ chunkId: item.chunkId, quote: item.quote })),
      })),
    },
  });
  const titles = new Map(passages.map((passage) => [passage.chunkId, passage.sourceTitle]));
  return {
    status: run.answer.status,
    reason: null,
    conversationId: saved.conversationId,
    model: label,
    sentences: run.answer.sentences.map((sentence) => ({
      text: sentence.text,
      support: sentence.support,
      evidence: sentence.evidence.map((item) => ({
        chunkId: item.chunkId,
        sourceId: item.sourceId,
        sourceTitle: titles.get(item.chunkId) ?? '',
        fileId: item.fileId,
        kind: item.kind,
        pageStart: item.pageStart,
        pageEnd: item.pageEnd,
        quote: item.quote,
      })),
    })),
    diagnostics: run.answer.diagnostics,
  };
}

export interface ClaimCheckReply {
  method: 'model-judgement-v1';
  reviewStatus: 'needs_human_review';
  model: string;
  conflict: boolean;
  strength: 'strong' | 'moderate' | 'limited' | 'none' | 'contested';
  judgements: (AssistantEvidence & { verdict: 'supports' | 'contradicts' | 'insufficient' })[];
}

/**
 * Checks one claim against this project's passages: a model judges each retrieved
 * passage (supports / contradicts / insufficient) with a verbatim quote; conflict and
 * strength are computed by code. Same gates as the assistant: consent, model, quota.
 */
export async function checkClaim(
  database: Database,
  context: SanadProjectContext,
  input: { claim: string },
): Promise<ClaimCheckReply> {
  if (!(await getProjectAiConsent(database, context)).enabled) {
    throw new AssistantRequestError('AI_CONSENT_REQUIRED', 409);
  }
  let model;
  let label: string;
  try {
    const ref = loadChatModelRef(process.env);
    model = resolveLanguageModel(ref, process.env);
    label = `${ref.provider}:${ref.model}`;
  } catch (error) {
    if (error instanceof AiConfigError) throw new AssistantRequestError('AI_NOT_CONFIGURED', 503);
    if (error instanceof AiProviderError) throw new AssistantRequestError(error.code, 503);
    throw error;
  }
  const retrieved = await retrieve(database, { ...context, query: input.claim, limit: 8 });
  const passages: AnswerPassage[] = retrieved.results.map((item) => ({
    chunkId: item.chunkId,
    sourceId: item.sourceId,
    content: item.content,
    kind: item.kind,
    fileId: item.fileId,
    fileSha256: item.fileSha256,
    pageStart: item.pageStart,
    pageEnd: item.pageEnd,
    sourceVerificationStatus: item.verificationStatus,
    sourceTitle: item.sourceTitle,
  }));
  const base = {
    method: 'model-judgement-v1' as const,
    reviewStatus: 'needs_human_review' as const,
    model: label,
  };
  if (passages.length === 0) return { ...base, conflict: false, strength: 'none', judgements: [] };

  let runId: string;
  try {
    ({ runId } = await startAssistantRun(database, context, {
      agent: 'evidence-judge',
      promptVersion: EVIDENCE_JUDGE_PROMPT_VERSION,
      provider: label.slice(0, label.indexOf(':')),
      model: label.slice(label.indexOf(':') + 1),
    }));
  } catch (error) {
    if (error instanceof AssistantError && error.code in STATUS) {
      throw new AssistantRequestError(error.code, STATUS[error.code] ?? 400);
    }
    throw error;
  }
  const started = Date.now();
  try {
    const { verification, usage } = await verifyClaimAgainstPassages({
      model,
      claim: input.claim,
      passages,
    });
    await finishAssistantRun(database, context, runId, {
      status: 'succeeded',
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      latencyMs: Date.now() - started,
      errorCode: null,
    });
    const byChunk = new Map(passages.map((p) => [p.chunkId, p]));
    return {
      ...base,
      conflict: verification.conflict,
      strength: verification.strength,
      judgements: verification.judgements.map((j) => ({
        chunkId: j.chunkId,
        sourceId: j.sourceId,
        sourceTitle: byChunk.get(j.chunkId)?.sourceTitle ?? '',
        fileId: byChunk.get(j.chunkId)?.fileId ?? null,
        kind: j.kind,
        pageStart: j.pageStart,
        pageEnd: j.pageEnd,
        quote: j.quote,
        verdict: j.verdict,
      })),
    };
  } catch (error) {
    const code = error instanceof AiCallError ? error.code : 'AI_PROVIDER_ERROR';
    await finishAssistantRun(database, context, runId, {
      status: 'failed',
      inputTokens: null,
      outputTokens: null,
      latencyMs: Date.now() - started,
      errorCode: code,
    });
    throw new AssistantRequestError(
      code,
      code === 'AI_TIMEOUT' ? 504 : code === 'AI_PROVIDER_ERROR' ? 502 : 503,
    );
  }
}
