import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { loadCliEnv, roleUrlMismatches } from '../../src/cli/env';

// Placeholder credentials for parsing tests only; nothing connects anywhere.
const pw = 'x'.repeat(8);
const local = (user: string) => `postgresql://${user}:${pw}@localhost:5432/bahith`;

describe('loadCliEnv', () => {
  beforeEach(() => {
    // Keep the developer's real .env out of the test.
    vi.spyOn(process, 'loadEnvFile').mockImplementation(() => undefined);
    vi.stubEnv('AUTH_DATABASE_URL', '');
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

  it('requires the dedicated auth connection before provisioning migrations', () => {
    vi.stubEnv('DATABASE_ADMIN_URL', local('bahith'));
    vi.stubEnv('DATABASE_URL', local('bahith_app'));
    expect(() => loadCliEnv([], { requireAuth: true })).toThrow(/AUTH_DATABASE_URL/);
    vi.stubEnv('AUTH_DATABASE_URL', local('bahith_auth'));
    expect(loadCliEnv([], { requireAuth: true })).toMatchObject({
      authUrl: local('bahith_auth'),
      authPassword: pw,
    });
  });

  it.each([
    local('bahith_app'),
    'postgresql://bahith_auth@localhost:5432/bahith',
    `postgresql://bahith_auth:${pw}@localhost:5433/bahith`,
    `postgresql://bahith_auth:${pw}@localhost:5432/another`,
    'not-a-connection-string',
  ])(
    'rejects auth credentials for the wrong role or database without exposing values',
    (authUrl) => {
      vi.stubEnv('DATABASE_ADMIN_URL', local('bahith'));
      vi.stubEnv('DATABASE_URL', local('bahith_app'));
      vi.stubEnv('AUTH_DATABASE_URL', authUrl);
      expect(() => loadCliEnv([], { requireAuth: true })).toThrow(
        expect.objectContaining({ code: 'DB_CONFIG_INVALID' }),
      );
    },
  );
});

const admin = new URL(
  'postgresql://owner:o@ep-x.eu-central-1.aws.neon.tech/neondb?sslmode=require',
);

describe('roleUrlMismatches (names of problems only, never values)', () => {
  it('accepts the role on the same host, port and database', () => {
    const ok = new URL(
      'postgresql://bahith_auth:secret@ep-x.eu-central-1.aws.neon.tech/neondb?sslmode=require',
    );
    expect(roleUrlMismatches(ok, admin, 'bahith_auth')).toEqual([]);
  });

  it('names every mismatch without echoing any part of the URL', () => {
    const wrong = new URL(
      'postgresql://neondb_owner@ep-x-pooler.eu-central-1.aws.neon.tech:6543/other',
    );
    const problems = roleUrlMismatches(wrong, admin, 'bahith_auth');
    expect(problems).toEqual([
      'user is not bahith_auth',
      'password is missing',
      'host differs from DATABASE_ADMIN_URL',
      'port differs from DATABASE_ADMIN_URL',
      'database name differs from DATABASE_ADMIN_URL',
    ]);
    expect(problems.join(' ')).not.toMatch(/pooler|neondb_owner|other|6543/u);
  });
});
