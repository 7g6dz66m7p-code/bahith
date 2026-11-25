import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  endpointHost,
  isPooledHost,
  loadCliEnv,
  neonEndpointId,
  roleUrlMismatches,
  sameServer,
} from '../../src/cli/env';

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
    const wrong = new URL('postgresql://neondb_owner@ep-y.eu-central-1.aws.neon.tech:6543/other');
    const problems = roleUrlMismatches(wrong, admin, 'bahith_auth');
    expect(problems).toEqual([
      'user is not bahith_auth',
      'password is missing',
      'a different Neon endpoint than DATABASE_ADMIN_URL (another project or branch)',
      'port differs from DATABASE_ADMIN_URL',
      'database name differs from DATABASE_ADMIN_URL',
    ]);
    expect(problems.join(' ')).not.toMatch(/ep-y|neondb_owner|other|6543/u);
  });
});

describe('Neon direct and pooled hosts', () => {
  it('treat ep-x and ep-x-pooler as the same endpoint, and nothing else', () => {
    expect(endpointHost('ep-x-pooler.c-10.eu-central-1.aws.neon.tech')).toBe(
      endpointHost('ep-x.c-10.eu-central-1.aws.neon.tech'),
    );
    expect(endpointHost('ep-y.c-10.eu-central-1.aws.neon.tech')).not.toBe(
      endpointHost('ep-x.c-10.eu-central-1.aws.neon.tech'),
    );
    expect(isPooledHost('ep-x-pooler.c-10.eu-central-1.aws.neon.tech')).toBe(true);
    expect(isPooledHost('ep-x.c-10.eu-central-1.aws.neon.tech')).toBe(false);
    const pooledApp = new URL(
      'postgresql://bahith_app:p@ep-x-pooler.eu-central-1.aws.neon.tech/neondb?sslmode=require',
    );
    expect(roleUrlMismatches(pooledApp, admin, 'bahith_app')).toEqual([]);
  });
});

describe('pooled DATABASE_ADMIN_URL', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('is switched to the direct host of the same endpoint, credentials unchanged', () => {
    vi.spyOn(process, 'loadEnvFile').mockImplementation(() => undefined);
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const host = 'ep-x.c-1.eu-central-1.aws.neon.tech';
    const pooled = host.replace('ep-x.', 'ep-x-pooler.');
    vi.stubEnv('DATABASE_ADMIN_URL', `postgresql://owner:${pw}@${pooled}/neondb?sslmode=require`);
    vi.stubEnv('DATABASE_URL', `postgresql://bahith_app:${pw}@${pooled}/neondb?sslmode=require`);
    vi.stubEnv(
      'AUTH_DATABASE_URL',
      `postgresql://bahith_auth:${pw}@${host}/neondb?sslmode=require`,
    );
    const env = loadCliEnv(['--allow-remote'], { requireAuth: true });
    const admin = new URL(env.adminUrl);
    expect(admin.hostname).toBe(host);
    expect(admin.username).toBe('owner');
    expect(admin.password).toBe(pw);
    expect(admin.search).toBe('?sslmode=require');
  });
});

describe('Neon endpoint identity across host formats', () => {
  it('old and new (cell) host formats, pooled or not, are the same endpoint', () => {
    const forms = [
      'ep-old-shape-abc123.eu-central-1.aws.neon.tech',
      'ep-old-shape-abc123.c-10.eu-central-1.aws.neon.tech',
      'ep-old-shape-abc123-pooler.c-10.eu-central-1.aws.neon.tech',
    ];
    for (const a of forms) for (const b of forms) expect(sameServer(a, b)).toBe(true);
    expect(neonEndpointId(forms[2] ?? '')).toBe('ep-old-shape-abc123');
  });

  it('a different endpoint (another project) is never the same server', () => {
    expect(
      sameServer('ep-a.c-10.eu-central-1.aws.neon.tech', 'ep-b.c-10.eu-central-1.aws.neon.tech'),
    ).toBe(false);
    const other = new URL('postgresql://bahith_app:p@ep-b.c-10.eu-central-1.aws.neon.tech/neondb');
    const admin = new URL('postgresql://o:p@ep-a.c-10.eu-central-1.aws.neon.tech/neondb');
    expect(roleUrlMismatches(other, admin, 'bahith_app')).toEqual([
      'a different Neon endpoint than DATABASE_ADMIN_URL (another project or branch)',
    ]);
  });
});
