import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { loadCliEnv } from '../../src/cli/env';

// Placeholder credentials for parsing tests only; nothing connects anywhere.
const pw = 'x'.repeat(8);
const local = (user: string) => `postgresql://${user}:${pw}@localhost:5432/bahith`;

describe('loadCliEnv', () => {
  beforeEach(() => {
    // Keep the developer's real .env out of the test.
    vi.spyOn(process, 'loadEnvFile').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('reads the admin and application URLs', () => {
    vi.stubEnv('DATABASE_ADMIN_URL', local('bahith'));
    vi.stubEnv('DATABASE_URL', local('bahith_app'));
    expect(loadCliEnv([])).toEqual({
      adminUrl: local('bahith'),
      appUrl: local('bahith_app'),
      appPassword: pw,
    });
  });

  it('fails with the names of the missing variables', () => {
    vi.stubEnv('DATABASE_ADMIN_URL', '');
    vi.stubEnv('DATABASE_URL', '');
    expect(() => loadCliEnv([])).toThrow(/DATABASE_ADMIN_URL, DATABASE_URL/);
  });

  it('refuses a non-local database unless --allow-remote is passed', () => {
    vi.stubEnv('DATABASE_ADMIN_URL', `postgresql://owner:${pw}@db.example.com:5432/bahith`);
    vi.stubEnv('DATABASE_URL', `postgresql://bahith_app:${pw}@db.example.com:5432/bahith`);
    expect(() => loadCliEnv([])).toThrow(
      expect.objectContaining({ code: 'DB_REMOTE_TARGET_REFUSED' }),
    );
    expect(loadCliEnv(['--allow-remote']).adminUrl).toContain('db.example.com');
  });

  it('requires a password for the application role', () => {
    vi.stubEnv('DATABASE_ADMIN_URL', local('bahith'));
    vi.stubEnv('DATABASE_URL', 'postgresql://bahith_app@localhost:5432/bahith');
    expect(() => loadCliEnv([])).toThrow(expect.objectContaining({ code: 'DB_CONFIG_INVALID' }));
  });

  it('decodes a URL-encoded application password', () => {
    vi.stubEnv('DATABASE_ADMIN_URL', local('bahith'));
    vi.stubEnv('DATABASE_URL', 'postgresql://bahith_app:p%40ss%2Fw@localhost:5432/bahith');
    expect(loadCliEnv([]).appPassword).toBe('p@ss/w');
  });
});
