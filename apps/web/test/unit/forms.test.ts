import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const SRC = path.resolve(import.meta.dirname, '../../src');

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    return statSync(full).isDirectory() ? files(full) : full.endsWith('.tsx') ? [full] : [];
  });
}

describe('forms', () => {
  it('every <form> declares method="post", so nothing is ever submitted in a URL', () => {
    const offenders: string[] = [];
    for (const file of files(SRC)) {
      for (const match of readFileSync(file, 'utf8').matchAll(/<form\b[^>]*>/gu)) {
        if (!/method="post"/u.test(match[0])) offenders.push(path.relative(SRC, file));
      }
    }
    expect(offenders).toEqual([]);
  });
});
