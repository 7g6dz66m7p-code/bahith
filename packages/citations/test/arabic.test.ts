import { describe, expect, it } from 'vitest';

import { hasArabicScript, matchKey, normalizeArabic } from '../src/index';

describe('normalizeArabic', () => {
  // Same cases as app.normalize_arabic in packages/db/test/integration/search.test.ts:
  // the TypeScript and SQL normalisers must agree.
  it.each([
    ['tashkeel is removed', 'الْإِحْصَاءُ', 'الاحصاء'],
    ['tatweel is removed', 'الـــعـــلم', 'العلم'],
    ['alef forms are unified', 'أحمد إبراهيم آمن ٱلله', 'احمد ابراهيم امن الله'],
    ['hamza carriers are unified', 'مسؤول شيئا', 'مسوول شييا'],
    ['alef maqsura and teh marbuta are unified', 'مستشفى مدرسة', 'مستشفي مدرسه'],
    ['Arabic-Indic digits become ASCII', 'عام ٢٠٢٤', 'عام 2024'],
    ['Persian yeh/kaf and digits are unified', 'کتابی ۱۲', 'كتابي 12'],
    ['Latin text is untouched', 'Research Methods 2024', 'Research Methods 2024'],
  ])('%s', (_name, input, expected) => {
    expect(normalizeArabic(input)).toBe(expected);
  });
});

describe('matchKey', () => {
  it('folds case, diacritics, punctuation, presentation forms and markup', () => {
    expect(matchKey('  Ébauche: <i>Résumé</i>, “Final”!  ')).toBe('ebauche resume final');
    expect(matchKey('ﺍﻟﻌﻠﻢ')).toBe('العلم');
    expect(matchKey('«المُقدّمة»')).toBe('المقدمه');
  });
});

describe('hasArabicScript', () => {
  it('detects Arabic letters', () => {
    expect(hasArabicScript('Deep learning')).toBe(false);
    expect(hasArabicScript('تعلم عميق')).toBe(true);
    expect(hasArabicScript('Mixed النص')).toBe(true);
  });
});
