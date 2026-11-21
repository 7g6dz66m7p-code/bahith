/**
 * Model-level evaluation of the grounded research assistant on the fixed SANAD corpus.
 * Needs a real provider: AI_CHAT_MODEL=provider:model and that provider's key. Without
 * them it stops with a clear message and reports nothing as measured.
 *
 * For each gold question the real retrieval feeds runGroundedAnswer (the product path);
 * for each out-of-corpus question the assistant must abstain. Scores:
 *  - answer rate: answerable questions with at least one supported sentence;
 *  - citation accuracy: verified evidence items of supported sentences that are on the
 *    gold source and cover the gold page;
 *  - correct abstention on out-of-corpus questions;
 *  - passages the model cited that it was not given, and quotes it altered (all rejected
 *    by the grounding step; counted to show how often the model tried).
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
  AiConfigError,
  AiProviderError,
  loadChatModelRef,
  MAX_ANSWER_PASSAGES,
  resolveLanguageModel,
  runGroundedAnswer,
} from '@bahith/ai';
import type { AnswerPassage, GroundedAnswerRun } from '@bahith/ai';
import { retrieve } from '@bahith/db';

import { covers, ratio } from './metrics';
import { withIngestedCorpus } from './setup';

const TARGETS = { citationAccuracy: 0.9, correctAbstention: 0.85 } as const;

let model;
let label: string;
try {
  const ref = loadChatModelRef(process.env);
  model = resolveLanguageModel(ref, process.env);
  label = `${ref.provider}:${ref.model}`;
} catch (error) {
  if (error instanceof AiConfigError || error instanceof AiProviderError) {
    process.stderr.write(
      `eval:assistant not run: ${error.message}\n` +
        'Set AI_CHAT_MODEL=provider:model and the provider key to measure the assistant.\n',
    );
    process.exit(2);
  }
  throw error;
}

const RESULTS_DIR = path.join(import.meta.dirname, 'results');

await withIngestedCorpus(async ({ corpus, app, ctx, sourceOf }) => {
  const language = new Map(corpus.documents.map((d) => [d.id, d.lang]));
  const ask = async (query: string, lang: 'ar' | 'en'): Promise<GroundedAnswerRun> => {
    const results = (await retrieve(app, { ...ctx, query, limit: MAX_ANSWER_PASSAGES })).results;
    const passages: AnswerPassage[] = results.map((item) => ({
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
    return runGroundedAnswer({ model, question: query, language: lang, passages });
  };

  const answerable = [];
  let evidenceTotal = 0;
  let evidenceOnGold = 0;
  let unknownPassages = 0;
  let unverifiedQuotes = 0;
  const latencies: number[] = [];
  for (const question of corpus.questions) {
    const lang = language.get(question.doc) === 'en' ? 'en' : 'ar';
    const run = await ask(question.query, lang);
    latencies.push(run.latencyMs);
    unknownPassages += run.answer.diagnostics.unknownPassages;
    unverifiedQuotes += run.answer.diagnostics.unverifiedQuotes;
    const gold = { sourceId: sourceOf.get(question.doc) ?? '', page: question.page };
    const supported = run.answer.sentences.filter((s) => s.support === 'supported');
    for (const item of supported.flatMap((s) => s.evidence)) {
      evidenceTotal += 1;
      if (covers(item, gold)) evidenceOnGold += 1;
    }
    answerable.push({
      id: question.id,
      status: run.answer.status,
      supported: supported.length,
      sentences: run.answer.sentences.length,
      diagnostics: run.answer.diagnostics,
      tokens: run.usage,
    });
  }
  const abstentions = [];
  for (const question of corpus.unanswerable) {
    const run = await ask(question.query, /[a-z]/iu.test(question.query) ? 'en' : 'ar');
    unknownPassages += run.answer.diagnostics.unknownPassages;
    unverifiedQuotes += run.answer.diagnostics.unverifiedQuotes;
    const supported = run.answer.sentences.filter((s) => s.support === 'supported').length;
    abstentions.push({ id: question.id, status: run.answer.status, supported });
  }
  const answered = answerable.filter((item) => item.supported > 0).length;
  const abstained = abstentions.filter((item) => item.supported === 0).length;
  const sorted = [...latencies].sort((x, y) => x - y);
  const metrics = {
    model: label,
    answerRate: ratio(answered, answerable.length),
    citationAccuracy: ratio(evidenceOnGold, evidenceTotal),
    correctAbstention: ratio(abstained, abstentions.length),
    rejectedUnknownPassages: unknownPassages,
    rejectedAlteredQuotes: unverifiedQuotes,
    latencyMsP50: sorted[Math.floor(sorted.length / 2)] ?? null,
    latencyMsP95: sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] ?? null,
  };
  const gates = {
    citationAccuracy: metrics.citationAccuracy >= TARGETS.citationAccuracy,
    correctAbstention: metrics.correctAbstention >= TARGETS.correctAbstention,
  };
  const report = {
    corpus: corpus.version,
    ranAt: new Date().toISOString(),
    targets: TARGETS,
    gates,
    metrics,
    details: { answerable, abstentions },
  };
  await mkdir(RESULTS_DIR, { recursive: true });
  await writeFile(
    path.join(RESULTS_DIR, 'assistant-latest.json'),
    `${JSON.stringify(report, null, 2)}\n`,
  );
  process.stdout.write(`${JSON.stringify({ gates, metrics }, null, 2)}\n`);
  if (!Object.values(gates).every(Boolean)) process.exitCode = 1;
});
