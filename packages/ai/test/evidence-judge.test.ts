import { MockLanguageModelV4 } from 'ai/test';
import { describe, expect, it } from 'vitest';

import { groundJudgements, summariseEvidence, verifyClaimAgainstPassages } from '../src/index';
import type { AnswerPassage, EvidenceJudgement } from '../src/index';

// Synthetic passages (test data, not real research).
const passage = (
  n: number,
  source: string,
  content: string,
  kind: 'full_text' | 'abstract' = 'full_text',
): AnswerPassage => ({
  chunkId: `00000000-0000-4000-8000-00000000000${String(n)}`,
  sourceId: `00000000-0000-4000-8000-0000000000${source}`,
  content,
  kind,
  fileId: kind === 'abstract' ? null : '00000000-0000-4000-8000-0000000000ff',
  fileSha256: kind === 'abstract' ? null : 'c'.repeat(64),
  pageStart: kind === 'abstract' ? null : n,
  pageEnd: kind === 'abstract' ? null : n,
  sourceVerificationStatus: 'unverified',
  sourceTitle: 'Synthetic',
});

const passages = [
  passage(
    1,
    'a1',
    'أظهرت النتائج أن التعلم المدمج رفع التحصيل بنسبة 18% مقارنة بالمجموعة الضابطة.',
  ),
  passage(2, 'b2', 'لم تجد هذه الدراسة أي أثر دال للتعلم المدمج على التحصيل في الرياضيات.'),
  passage(3, 'c3', 'Blended learning raised achievement in a second cohort by 12%.'),
  passage(4, 'd4', 'ملخص: التعلم المدمج يحسن التحصيل.', 'abstract'),
];

const j = (
  verdict: EvidenceJudgement['verdict'],
  sourceId: string,
  kind: 'full_text' | 'abstract' = 'full_text',
): EvidenceJudgement => ({
  chunkId: sourceId,
  sourceId,
  verdict,
  quote: 'q',
  pageStart: 1,
  pageEnd: 1,
  kind,
});

describe('evidence summary (deterministic)', () => {
  it('grades strength by independent full-text sources, abstracts alone are limited', () => {
    expect(summariseEvidence([j('supports', 's1'), j('supports', 's2')]).strength).toBe('strong');
    expect(summariseEvidence([j('supports', 's1'), j('supports', 's1')]).strength).toBe('moderate');
    expect(summariseEvidence([j('supports', 's1', 'abstract')]).strength).toBe('limited');
    expect(summariseEvidence([j('insufficient', 's1')]).strength).toBe('none');
  });

  it('flags a conflict when sources disagree', () => {
    expect(summariseEvidence([j('supports', 's1'), j('contradicts', 's2')])).toEqual({
      conflict: true,
      strength: 'contested',
    });
  });
});

describe('groundJudgements', () => {
  it('keeps verbatim quotes, turns unverifiable verdicts into insufficient, drops unknown passages', () => {
    const grounded = groundJudgements(
      {
        judgements: [
          { passage: 'P1', verdict: 'supports', quote: 'رفع التحصيل بنسبة 18%' },
          { passage: 'P2', verdict: 'contradicts', quote: 'لم تجد هذه الدراسة أي أثر دال' },
          { passage: 'P3', verdict: 'supports', quote: 'raised achievement by 30%' },
          { passage: 'P9', verdict: 'supports', quote: 'invented' },
        ],
      },
      passages,
    );
    expect(grounded.judgements.map((x) => [x.verdict, x.pageStart])).toEqual([
      ['supports', 1],
      ['contradicts', 2],
      ['insufficient', 3],
    ]);
    expect(grounded.conflict).toBe(true);
    expect(grounded.strength).toBe('contested');
    expect(grounded.diagnostics).toEqual({ unknownPassages: 1, unverifiedQuotes: 1 });
  });
});

describe('verifyClaimAgainstPassages (mock model, no provider)', () => {
  it('returns a model judgement that always needs human review', async () => {
    const reply = JSON.stringify({
      judgements: [
        { passage: 'P1', verdict: 'supports', quote: 'رفع التحصيل بنسبة 18%' },
        { passage: 'P3', verdict: 'supports', quote: 'Blended learning raised achievement' },
      ],
    });
    const model = new MockLanguageModelV4({
      doGenerate: () =>
        Promise.resolve({
          content: [{ type: 'text', text: reply }],
          finishReason: { unified: 'stop', raw: undefined },
          usage: {
            inputTokens: { total: 50, noCache: 50, cacheRead: undefined, cacheWrite: undefined },
            outputTokens: { total: 20, text: 20, reasoning: undefined },
          },
          warnings: [],
        }),
    });
    const { verification } = await verifyClaimAgainstPassages({
      model,
      claim: 'التعلم المدمج يرفع التحصيل',
      passages,
    });
    expect(verification).toMatchObject({
      method: 'model-judgement-v1',
      reviewStatus: 'needs_human_review',
      promptVersion: 'evidence-judge@1',
      conflict: false,
      strength: 'strong',
    });
  });
});
