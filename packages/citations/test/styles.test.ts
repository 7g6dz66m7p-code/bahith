import { schema } from '@bahith/db';
import { describe, expect, it } from 'vitest';

import {
  ALL_FORMAT_STYLES,
  CITATION_STYLES,
  isCitationStyle,
  isFormatStyle,
  isNoteStyle,
  NOTE_STYLES,
} from '../src/index';

describe('citation styles', () => {
  it('match the styles a project can store in the database', () => {
    expect([...CITATION_STYLES]).toEqual(schema.citationStyleEnum.enumValues);
  });

  it('recognises supported styles only', () => {
    expect(isCitationStyle('apa-7')).toBe(true);
    expect(isCitationStyle('harvard')).toBe(false);
  });

  it('format styles extend the storable styles with notes and the traditional Arabic style', () => {
    expect([...ALL_FORMAT_STYLES]).toEqual([
      'apa-7',
      'chicago',
      'mla',
      'chicago-notes',
      'arabic-traditional',
    ]);
    expect(isFormatStyle('arabic-traditional')).toBe(true);
    expect(isCitationStyle('arabic-traditional')).toBe(false);
    expect(isFormatStyle('harvard')).toBe(false);
    expect(NOTE_STYLES.every((style) => isFormatStyle(style))).toBe(true);
    expect(isNoteStyle('chicago-notes')).toBe(true);
    expect(isNoteStyle('apa-7')).toBe(false);
  });
});
