import { describe, expect, it } from 'vitest';

import { covers, firstHit, perturbations, scoreRetrieval } from './metrics';

const gold = { sourceId: 's1', page: 2 };

describe('SANAD eval metrics', () => {
  it('a passage counts only when its stored page range covers the gold page', () => {
    expect(covers({ sourceId: 's1', pageStart: 1, pageEnd: 2 }, gold)).toBe(true);
    expect(covers({ sourceId: 's1', pageStart: 3, pageEnd: 4 }, gold)).toBe(false);
    expect(covers({ sourceId: 's2', pageStart: 2, pageEnd: 2 }, gold)).toBe(false);
    expect(covers({ sourceId: 's1', pageStart: null, pageEnd: null }, gold)).toBe(false);
  });

  it('scores recall, MRR and exact-page accuracy', () => {
    const hitSecond = [
      { sourceId: 's2', pageStart: 2, pageEnd: 2 },
      { sourceId: 's1', pageStart: 2, pageEnd: 3 },
    ];
    const exactTop = [{ sourceId: 's1', pageStart: 2, pageEnd: 2 }];
    expect(firstHit(hitSecond, gold)).toBe(2);
    expect(
      scoreRetrieval([
        { results: hitSecond, gold },
        { results: exactTop, gold },
        { results: [], gold },
        { results: [{ sourceId: 's1', pageStart: 1, pageEnd: 2 }], gold },
      ]),
    ).toEqual({ questions: 4, recallAt1: 0.5, recallAt10: 0.75, mrr: 2.5 / 4, exactPageAt1: 0.25 });
  });

  it('perturbs numbers (Arabic-Indic too), drops or swaps words, never returns the original', () => {
    expect(perturbations('ارتفع بنسبة 18% مقارنة بالمجموعة الضابطة')).toEqual([
      { kind: 'number_changed', quote: 'ارتفع بنسبة 25% مقارنة بالمجموعة الضابطة' },
      { kind: 'words_swapped', quote: 'ارتفع 18% بنسبة مقارنة بالمجموعة الضابطة' },
    ]);
    expect(perturbations('بنسبة ١٢٪ فقط')[0]).toEqual({
      kind: 'number_changed',
      quote: 'بنسبة 19٪ فقط',
    });
    const kinds = perturbations('اقتصرت الدراسة على مادة الرياضيات').map((item) => item.kind);
    expect(kinds).toEqual(['word_dropped', 'words_swapped']);
    expect(perturbations('a a a a').every((item) => item.quote !== 'a a a a')).toBe(true);
  });
});
