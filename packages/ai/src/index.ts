export { AiConfigError, loadAiConfig } from './config';
export type { AiConfig, ModelRef } from './config';
export { extractClaimCandidates, SanadVerifyError, verifyQuotation } from './sanad/verify';
export type {
  ClaimCandidate,
  QuotationEvidence,
  QuotationMatch,
  QuotationRequest,
  SanadVerifyErrorCode,
} from './sanad/verify';
export {
  AiProviderError,
  loadChatModelRef,
  PROVIDER_KEY_VARIABLES,
  resolveLanguageModel,
} from './providers';
export type { AiProviderErrorCode, ProviderId } from './providers';
export {
  AiCallError,
  classifyAiError,
  groundAnswer,
  groundedAnswerOutputSchema,
  MAX_ANSWER_PASSAGES,
  passageHandles,
  runGroundedAnswer,
  stripModelCitations,
} from './agents/grounded-answer';
export type {
  AiCallErrorCode,
  AnswerPassage,
  GroundedAnswer,
  GroundedAnswerOutput,
  GroundedAnswerRun,
  GroundedEvidence,
  GroundedSentence,
} from './agents/grounded-answer';
export { escapeSourceText, GROUNDED_ANSWER_PROMPT_VERSION } from './prompts/grounded-answer';
export {
  EMBEDDING_BATCH_SIZE,
  EMBEDDING_DIMENSIONS,
  embedTexts,
  loadEmbeddingModelRef,
  resolveEmbeddingModel,
} from './embeddings';
export type { EmbeddingBatch } from './embeddings';
export {
  evidenceJudgeOutputSchema,
  groundJudgements,
  summariseEvidence,
  verifyClaimAgainstPassages,
} from './agents/evidence-judge';
export type {
  ClaimVerification,
  EvidenceJudgeOutput,
  EvidenceJudgement,
  EvidenceStrength,
} from './agents/evidence-judge';
export { EVIDENCE_JUDGE_PROMPT_VERSION } from './prompts/evidence-judge';
