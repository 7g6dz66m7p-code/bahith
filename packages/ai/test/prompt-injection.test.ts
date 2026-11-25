import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { escapeSourceText, groundAnswer, stripModelCitations } from '../src/index';
import type { AnswerPassage } from '../src/index';
import { groundedAnswerUserPrompt } from '../src/prompts/grounded-answer';

const set = z
  .object({
    version: z.string(),
    payloads: z.array(
      z.object({
        id: z.string(),
        lang: z.enum(['ar', 'en']),
        where: z.enum(['passage', 'title', 'question']),
        text: z.string(),
      }),
    ),
    compromisedOutputs: z.array(
      z.object({
        id: z.string(),
        follows: z.string(),
        sentence: z.string(),
        evidence: z.array(z.object({ passage: z.string(), quote: z.string() })),
      }),
    ),
  })
  .parse(
    JSON.parse(
      readFileSync(path.join(import.meta.dirname, 'fixtures/prompt-injection.json'), 'utf8'),
    ),
  );

const passageOf = (content: string): AnswerPassage => ({
  chunkId: '00000000-0000-4000-8000-000000000001',
  sourceId: '00000000-0000-4000-8000-0000000000aa',
  content,
  kind: 'full_text',
  fileId: '00000000-0000-4000-8000-0000000000bb',
  fileSha256: 'b'.repeat(64),
  pageStart: 3,
  pageEnd: 3,
  sourceVerificationStatus: 'unverified',
  sourceTitle: 'Synthetic study',
});

/** Prompt-structure tags as a model would read them (ignoring case, spaces, format chars). */
function structuralTags(prompt: string): string[] {
  return [...prompt.matchAll(/<(\s*\/?\s*)([\p{L}\p{Cf}_]+)/gu)]
    .filter((m) => m.index === 0 || prompt[m.index - 1] !== '\\')
    .map(
      (m) =>
        `${(m[1] ?? '').replace(/\s/gu, '')}${(m[2] ?? '').replace(/\p{Cf}/gu, '').toLowerCase()}`,
    )
    .filter((tag) => /^\/?(source_document|question|system|instructions)$/u.test(tag));
}

describe(`prompt injection set (${set.version})`, () => {
  it.each(set.payloads)('$id ($lang, in $where) cannot open or close a prompt block', (payload) => {
    const prompt = groundedAnswerUserPrompt(
      payload.where === 'question' ? payload.text : 'What did the study find?',
      [
        {
          handle: 'P1',
          title: payload.where === 'title' ? payload.text : 'Synthetic study',
          content: payload.where === 'passage' ? payload.text : 'Results were mixed.',
        },
      ],
    );
    // Exactly the structure the application wrote: one document block and one question.
    expect(structuralTags(prompt)).toEqual([
      'source_document',
      '/source_document',
      'question',
      '/question',
    ]);
  });

  it('leaves ordinary angle brackets (statistics, labels) untouched so quotes still match', () => {
    const text = set.payloads.find((p) => p.id === 'pi10')?.text ?? '';
    expect(escapeSourceText(text)).toBe(text);
  });

  it.each(set.compromisedOutputs)(
    '$id: output that follows $follows is neutralised by grounding',
    (output) => {
      const payload = set.payloads.find((p) => p.id === output.follows);
      const answer = groundAnswer(
        {
          abstain: false,
          sentences: [{ text: output.sentence, kind: 'supported', evidence: output.evidence }],
        },
        [passageOf(payload?.where === 'passage' ? payload.text : 'Results were mixed.')],
      );
      for (const sentence of answer.sentences) {
        // No page or reference text survives from the model.
        expect(sentence.text).not.toMatch(
          /\b(?:p|pp)\.\s*\d|\b(?:19|20)\d{2}\b|ص\s*[0-9٠-٩]|[٠-٩]{4}/u,
        );
        // Any remaining evidence is a verbatim span of the passage actually sent, page from storage.
        for (const item of sentence.evidence) {
          expect(item.pageStart).toBe(3);
          expect(item.chunkId).toBe('00000000-0000-4000-8000-000000000001');
        }
        // A claim without verified evidence is never shown as supported.
        if (sentence.evidence.length === 0) expect(sentence.support).not.toBe('supported');
      }
    },
  );

  it('strips model-written references and pages in Arabic and English', () => {
    expect(stripModelCitations('Results were mixed (Smith, 2020, p. 999).')).toEqual({
      text: 'Results were mixed.',
      removed: 1,
    });
    expect(stripModelCitations('كانت النتائج متباينة (الأحمد، ٢٠١٩، ص ١٢).').text).toBe(
      'كانت النتائج متباينة.',
    );
    expect(stripModelCitations('see page 12 and ص ٤٥ for details').removed).toBe(2);
    // Ordinary parentheses and numbers are kept.
    expect(stripModelCitations('The effect (in group A) was 18%.')).toEqual({
      text: 'The effect (in group A) was 18%.',
      removed: 0,
    });
  });
});
