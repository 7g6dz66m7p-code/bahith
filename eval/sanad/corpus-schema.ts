import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { z } from 'zod';

export const CORPUS_DIR = path.join(import.meta.dirname, 'corpus');

const page = z.number().int().positive();

export const corpusSchema = z.strictObject({
  note: z.string(),
  version: z.string(),
  documents: z.array(
    z.strictObject({
      id: z.string(),
      fileName: z.string().regex(/^[a-z0-9-]+\.pdf$/u),
      lang: z.enum(['ar', 'en']),
      dir: z.enum(['rtl', 'ltr']),
      scanned: z.boolean(),
      pages: z.array(z.array(z.string().min(1)).min(1)).min(1),
    }),
  ),
  questions: z.array(z.strictObject({ id: z.string(), query: z.string(), doc: z.string(), page })),
  unanswerable: z.array(z.strictObject({ id: z.string(), query: z.string() })),
  quotes: z.array(
    z.strictObject({ id: z.string(), doc: z.string(), page, quote: z.string().min(1) }),
  ),
  fabricatedQuotes: z.array(z.strictObject({ id: z.string(), quote: z.string().min(1) })),
});

export type Corpus = z.infer<typeof corpusSchema>;

/** Loads the corpus and checks that the gold set is consistent with the source text. */
export async function loadCorpus(): Promise<Corpus> {
  const corpus = corpusSchema.parse(
    JSON.parse(await readFile(path.join(CORPUS_DIR, 'corpus.json'), 'utf8')),
  );
  const documents = new Map(corpus.documents.map((document) => [document.id, document]));
  for (const item of [...corpus.questions, ...corpus.quotes]) {
    const document = documents.get(item.doc);
    if (document === undefined || item.page > document.pages.length) {
      throw new Error(`gold item ${item.id} points at a missing document or page`);
    }
  }
  for (const quote of corpus.quotes) {
    const text = documents.get(quote.doc)?.pages[quote.page - 1]?.join('\n') ?? '';
    if (!text.includes(quote.quote)) {
      throw new Error(`gold quote ${quote.id} is not in the source text of its page`);
    }
  }
  return corpus;
}
