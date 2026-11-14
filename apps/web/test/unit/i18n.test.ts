import { describe, expect, it } from 'vitest';

import ar from '../../messages/ar.json';
import en from '../../messages/en.json';

import { localeDirection, routing } from '@/i18n/routing';

/** All leaf keys of a message tree, as dotted paths. */
function keysOf(node: unknown, prefix = ''): string[] {
  if (typeof node !== 'object' || node === null) {
    return [prefix];
  }
  return Object.entries(node).flatMap(([key, value]) =>
    keysOf(value, prefix === '' ? key : `${prefix}.${key}`),
  );
}

function leaves(node: unknown): string[] {
  if (typeof node !== 'object' || node === null) {
    return [String(node)];
  }
  return Object.values(node).flatMap((value) => leaves(value));
}

describe('i18n', () => {
  it('is Arabic first', () => {
    expect(routing.defaultLocale).toBe('ar');
    expect(routing.locales).toEqual(['ar', 'en']);
  });

  it('maps locales to writing directions', () => {
    expect(localeDirection('ar')).toBe('rtl');
    expect(localeDirection('en')).toBe('ltr');
  });

  it('has exactly the same message keys in Arabic and English', () => {
    expect(keysOf(en).sort()).toEqual(keysOf(ar).sort());
  });

  it('has no empty message', () => {
    for (const text of [...leaves(ar), ...leaves(en)]) {
      expect(text.trim()).not.toBe('');
    }
  });
});
