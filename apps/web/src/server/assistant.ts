import type { AnswerPassage, GroundedAnswer } from '@bahith/ai';
import {
  AiCallError,
  AiConfigError,
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

  const retrieved = await retrieve(database, {
    ...context,
    query: input.question,
    limit: MAX_ANSWER_PASSAGES,
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
  const empty = { unknownPassages: 0, unverifiedQuotes: 0, downgraded: 0 };
  if (passages.length === 0) {
    return {
      status: 'abstained',
      reason: 'NO_EVIDENCE',
      conversationId: input.conversationId,
      model: label,
      sentences: [],
      diagnostics: empty,
    };
  }

  let runId: string;
  try {
    ({ runId } = await startAssistantRun(database, context, {
      agent: 'grounded-answer',
      promptVersion: 'grounded-answer@1',
      provider: label.slice(0, label.indexOf(':')),
      model: label.slice(label.indexOf(':') + 1),
    }));
  } catch (error) {
    if (error instanceof AssistantError && error.code in STATUS) {
      throw new AssistantRequestError(error.code, STATUS[error.code] ?? 400);
    }
    throw error;
  }

  let run;
  try {
    run = await runGroundedAnswer({
      model,
      question: input.question,
      language: input.language,
      passages,
    });
  } catch (error) {
    const code = error instanceof AiCallError ? error.code : 'AI_PROVIDER_ERROR';
    await finishAssistantRun(database, context, runId, {
      status: 'failed',
      inputTokens: null,
      outputTokens: null,
      latencyMs: null,
      errorCode: code,
    });
    throw new AssistantRequestError(code, code === 'AI_TIMEOUT' ? 504 : 502);
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
