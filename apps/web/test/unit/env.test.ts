import { describe, expect, it } from 'vitest';

import { EnvError, parseServerEnv } from '@/server/env';

const valid = {
  DATABASE_URL: 'postgresql://bahith_app:placeholder@localhost:5432/bahith',
  REDIS_URL: 'redis://:placeholder@localhost:6379',
};

describe('parseServerEnv', () => {
  it('accepts a complete configuration', () => {
    expect(parseServerEnv(valid)).toEqual(valid);
  });

  it('names every missing variable', () => {
    expect(() => parseServerEnv({})).toThrow(EnvError);
    try {
      parseServerEnv({});
    } catch (error) {
      expect(error).toMatchObject({
        code: 'CONFIG_INVALID',
        variables: ['DATABASE_URL', 'REDIS_URL'],
      });
    }
  });

  it('rejects a URL with the wrong protocol without echoing its value', () => {
    const secretUrl = 'https://user:hunter2@example.com/db';
    try {
      parseServerEnv({ ...valid, DATABASE_URL: secretUrl });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(EnvError);
      expect((error as EnvError).message).not.toContain('hunter2');
      expect((error as EnvError).variables).toEqual(['DATABASE_URL']);
    }
  });
});
