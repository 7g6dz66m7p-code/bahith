import { schema } from '@bahith/db';
import { describe, expect, it } from 'vitest';

import { CITATION_STYLES, isCitationStyle } from '../src/index';

describe('citation styles', () => {
  it('match the styles a project can store in the database', () => {
    expect([...CITATION_STYLES]).toEqual(schema.citationStyleEnum.enumValues);
  });

  it('recognises supported styles only', () => {
    expect(isCitationStyle('apa-7')).toBe(true);
    expect(isCitationStyle('harvard')).toBe(false);
  });
});
