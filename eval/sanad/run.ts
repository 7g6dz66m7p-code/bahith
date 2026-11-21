/**
 * SANAD evaluation on a fixed synthetic corpus, through the real pipeline:
 * committed PDFs → the worker's Python extractor (pdfium text, Tesseract OCR for the
 * scanned document) → ingestExtraction into a real Postgres 16 + pgvector container
 * → project-scoped retrieve() → verifyQuotation().
 *
 * Measures retrieval (Recall@1/@10, MRR), page accuracy of the stored evidence,
 * verbatim quote acceptance, false acceptance of corrupted and fabricated quotes, and
 * retrieval-level abstention. Nothing here calls a language model: answer-level
 * citation precision and model abstention need a configured AI provider and are
 * reported as not measured. Writes results/latest.json and results/latest.md.
 */
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import { verifyQuotation } from '@bahith/ai';
import {
  createDatabase,
  createProject,
  ingestExtraction,
  registerUpload,
  retrieve,
  schema,
} from '@bahith/db';
import type { SanadEvidence } from '@bahith/db';
import { seedReferenceData, startTestDatabase } from '@bahith/db/testing';

import { CORPUS_DIR, loadCorpus } from './corpus-schema';
import { covers, perturbations, ratio, scoreRetrieval } from './metrics';
import type { Gold } from './metrics';

const run = promisify(execFile);
const ROOT = path.resolve(import.meta.dirname, '../..');
const RESULTS_DIR = path.join(import.meta.dirname, 'results');

/** Gates: the build fails when any is missed. Documented in eval/README.md. */
const TARGETS = {
  recallAt10: 0.8,
  exactQuotePageCorrect: 0.9,
  falseAcceptance: 0,
  retrievalAbstention: 0.85,
} as const;

const corpus = await loadCorpus();
const started = Date.now();
const database = await startTestDatabase();
const admin = createDatabase({ connectionString: database.adminUrl });
const app = createDatabase({ connectionString: database.appUrl });
const auth = createDatabase({ connectionString: database.authUrl });

try {
  const client = await admin.pool.connect();
  try {
    await seedReferenceData(client);
  } finally {
    client.release();
  }
  const [user] = await auth.db
    .insert(schema.users)
    .values({ email: `eval-${randomUUID()}@example.test`, name: 'SANAD evaluation' })
    .returning({ id: schema.users.id });
  if (user === undefined) throw new Error('user not created');
  const [workspace] = await app.withUser(user.id, (tx) =>
    tx.select({ id: schema.workspaces.id }).from(schema.workspaces),
  );
  if (workspace === undefined) throw new Error('personal workspace missing');
  const project = await createProject(app, user.id, {
    workspaceId: workspace.id,
    title: 'SANAD evaluation',
  });
  const ctx = { userId: user.id, workspaceId: workspace.id, projectId: project.id };

  // Ingest every document through the real extractor.
  const sourceOf = new Map<string, string>();
  const extraction: Record<string, unknown>[] = [];
  for (const document of corpus.documents) {
    const filePath = path.join(CORPUS_DIR, document.fileName);
    const bytes = await readFile(filePath);
    const fileId = randomUUID();
    const upload = await registerUpload(app, ctx, {
      fileId,
      originalName: document.fileName,
      mimeType: 'application/pdf',
      sizeBytes: bytes.byteLength,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      storageKey: `workspaces/${workspace.id}/files/${fileId}/original`,
    });
    const t0 = Date.now();
    const { stdout } = await run(
      'uv',
      [
        'run',
        '--quiet',
        '--project',
        path.join(ROOT, 'apps/worker'),
        'python',
        '-I',
        path.join(import.meta.dirname, 'extract.py'),
        filePath,
        'application/pdf',
      ],
      { maxBuffer: 64 * 1024 * 1024 },
    );
    const extractMs = Date.now() - t0;
    const manifest = JSON.parse(stdout) as {
      units: { method?: string }[];
      chunks: unknown[];
      failures: unknown[];
      extractorVersion: string;
    };
    const ingested = await ingestExtraction(app, { ...ctx, fileId: upload.fileId, manifest });
    sourceOf.set(document.id, upload.sourceId);
    extraction.push({
      document: document.id,
      scanned: document.scanned,
      pages: document.pages.length,
      ocrUnits: manifest.units.filter((unit) => unit.method === 'ocr').length,
      chunks: manifest.chunks.length,
      failures: manifest.failures.length,
      status: ingested.status,
      extractor: manifest.extractorVersion,
      extractMs,
    });
  }

  const goldOf = (doc: string, page: number): Gold => ({
    sourceId: sourceOf.get(doc) ?? '',
    page,
  });
  const search = async (query: string) =>
    (await retrieve(app, { ...ctx, query, limit: 10 })).results;

  // 1. Retrieval and page accuracy.
  const retrievalCases = [];
  const perQuestion = [];
  let mode: string | null = null;
  for (const question of corpus.questions) {
    const response = await retrieve(app, { ...ctx, query: question.query, limit: 10 });
    mode = response.mode;
    const gold = goldOf(question.doc, question.page);
    retrievalCases.push({ results: response.results, gold });
    const top = response.results[0];
    perQuestion.push({
      id: question.id,
      doc: question.doc,
      page: question.page,
      results: response.results.length,
      hitRank: response.results.findIndex((passage) => covers(passage, gold)) + 1 || null,
      top:
        top === undefined
          ? null
          : { page: [top.pageStart, top.pageEnd], onTarget: covers(top, gold) },
    });
  }
  const scanned = new Set(corpus.documents.filter((d) => d.scanned).map((d) => d.id));
  const retrievalAll = scoreRetrieval(retrievalCases);
  const retrievalDigital = scoreRetrieval(
    retrievalCases.filter((_, i) => !scanned.has(corpus.questions[i]?.doc ?? '')),
  );
  const retrievalOcr = scoreRetrieval(
    retrievalCases.filter((_, i) => scanned.has(corpus.questions[i]?.doc ?? '')),
  );

  // 2. Retrieval-level abstention: no passage at all for out-of-corpus questions.
  const abstentions = [];
  for (const question of corpus.unanswerable) {
    abstentions.push({ id: question.id, results: (await search(question.query)).length });
  }
  const abstained = abstentions.filter((item) => item.results === 0).length;

  // 3. Quotation verification against the passages retrieval returns for the quote.
  const evidenceOf = (results: SanadEvidence[]) =>
    results.map((item) => ({
      chunkId: item.chunkId,
      sourceId: item.sourceId,
      content: item.content,
      kind: item.kind,
      fileId: item.fileId,
      fileSha256: item.fileSha256,
      pageStart: item.pageStart,
      pageEnd: item.pageEnd,
      sourceVerificationStatus: item.verificationStatus,
    }));
  const check = async (quote: string) => {
    const evidence = evidenceOf(await search(quote));
    for (const passage of evidence) {
      try {
        return verifyQuotation({ chunkId: passage.chunkId, quote }, evidence);
      } catch {
        // Not in this passage; try the next allow-listed one.
      }
    }
    return null;
  };
  const exact = [];
  const corrupted = [];
  for (const item of corpus.quotes) {
    const match = await check(item.quote);
    const gold = goldOf(item.doc, item.page);
    exact.push({
      id: item.id,
      doc: item.doc,
      accepted: match !== null,
      pageCorrect: match !== null && covers(match, gold),
      page: match === null ? null : [match.pageStart, match.pageEnd],
    });
    for (const variant of perturbations(item.quote)) {
      corrupted.push({
        id: `${item.id}:${variant.kind}`,
        kind: variant.kind,
        accepted: (await check(variant.quote)) !== null,
      });
    }
  }
  for (const item of corpus.fabricatedQuotes) {
    corrupted.push({
      id: item.id,
      kind: 'fabricated',
      accepted: (await check(item.quote)) !== null,
    });
  }
  const accepted = exact.filter((item) => item.accepted).length;
  const pageCorrect = exact.filter((item) => item.pageCorrect).length;
  const falseAccepted = corrupted.filter((item) => item.accepted);

  const metrics = {
    retrievalMode: mode,
    retrieval: { all: retrievalAll, bornDigital: retrievalDigital, ocr: retrievalOcr },
    retrievalAbstention: ratio(abstained, abstentions.length),
    exactQuoteAcceptance: ratio(accepted, exact.length),
    exactQuotePageCorrect: ratio(pageCorrect, exact.length),
    falseAcceptance: ratio(falseAccepted.length, corrupted.length),
    counts: {
      documents: corpus.documents.length,
      pages: corpus.documents.reduce((sum, d) => sum + d.pages.length, 0),
      questions: corpus.questions.length,
      unanswerable: abstentions.length,
      exactQuotes: exact.length,
      corruptedOrFabricatedQuotes: corrupted.length,
    },
    notMeasured: {
      answerCitationPrecision: 'needs a configured AI provider (no model answers are generated)',
      modelAbstention: 'needs a configured AI provider',
      semanticRetrieval: 'needs real embeddings from a configured provider; lexical only',
    },
  };
  const gates = {
    recallAt10: retrievalAll.recallAt10 >= TARGETS.recallAt10,
    exactQuotePageCorrect: metrics.exactQuotePageCorrect >= TARGETS.exactQuotePageCorrect,
    falseAcceptance: metrics.falseAcceptance <= TARGETS.falseAcceptance,
    retrievalAbstention: metrics.retrievalAbstention >= TARGETS.retrievalAbstention,
  };
  const report = {
    corpus: corpus.version,
    ranAt: new Date().toISOString(),
    durationMs: Date.now() - started,
    targets: TARGETS,
    gates,
    metrics,
    extraction,
    details: { questions: perQuestion, abstentions, exact, corrupted },
  };
  await mkdir(RESULTS_DIR, { recursive: true });
  await writeFile(path.join(RESULTS_DIR, 'latest.json'), `${JSON.stringify(report, null, 2)}\n`);

  const pct = (value: number) => `${(value * 100).toFixed(1)}%`;
  const row = (name: string, value: string, target: string, ok?: boolean) =>
    `| ${name} | ${value} | ${target} | ${ok === undefined ? '—' : ok ? '✅' : '❌'} |`;
  const markdown = [
    `# SANAD evaluation — ${corpus.version}`,
    '',
    `Ran ${report.ranAt} in ${(report.durationMs / 1000).toFixed(0)} s; retrieval mode: ${String(mode)}.`,
    '',
    '| Metric | Value | Target | Pass |',
    '| --- | --- | --- | --- |',
    row('Recall@10 (all)', pct(retrievalAll.recallAt10), '≥ 80%', gates.recallAt10),
    row('Recall@1 (all)', pct(retrievalAll.recallAt1), '—'),
    row('MRR (all)', retrievalAll.mrr.toFixed(3), '—'),
    row('Exact page @1 (all)', pct(retrievalAll.exactPageAt1), '—'),
    row(
      'Recall@10 born-digital / OCR',
      `${pct(retrievalDigital.recallAt10)} / ${pct(retrievalOcr.recallAt10)}`,
      '—',
    ),
    row('Exact quotes accepted', pct(metrics.exactQuoteAcceptance), '—'),
    row(
      'Exact quotes accepted on the gold page',
      pct(metrics.exactQuotePageCorrect),
      '≥ 90%',
      gates.exactQuotePageCorrect,
    ),
    row(
      'False acceptance (corrupted + fabricated)',
      `${pct(metrics.falseAcceptance)} (${String(falseAccepted.length)}/${String(corrupted.length)})`,
      '0%',
      gates.falseAcceptance,
    ),
    row(
      'Retrieval-level abstention',
      pct(metrics.retrievalAbstention),
      '≥ 85%',
      gates.retrievalAbstention,
    ),
    '',
    'Not measured (needs an AI provider): answer citation precision, model abstention, semantic retrieval.',
    '',
  ].join('\n');
  await writeFile(path.join(RESULTS_DIR, 'latest.md'), markdown);
  process.stdout.write(markdown);
  if (!Object.values(gates).every(Boolean)) process.exitCode = 1;
} finally {
  await Promise.allSettled([app.close(), admin.close(), auth.close()]);
  await database.stop();
}
