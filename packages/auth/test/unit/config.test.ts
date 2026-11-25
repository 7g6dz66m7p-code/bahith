import { describe, expect, it } from 'vitest';

import { createBahithAuth } from '../../src/auth';
import { AuthConfigError, parseAuthConfig } from '../../src/config';
import { enforceSocialSecondFactor, isSocialSessionPath } from '../../src/oauth-policy';

function validEnv() {
  return {
    AUTH_DATABASE_URL: 'postgresql://bahith_auth@localhost/bahith',
    BETTER_AUTH_SECRET: crypto.randomUUID(),
    BETTER_AUTH_URL: 'http://localhost:3000',
  };
}

describe('private auth configuration and second-factor policy', () => {
  it('accepts explicit loopback development configuration without assuming a mail provider', () => {
    const env = validEnv();
    expect(parseAuthConfig(env)).toEqual({
      databaseUrl: env.AUTH_DATABASE_URL,
      secret: env.BETTER_AUTH_SECRET,
      baseUrl: env.BETTER_AUTH_URL,
    });
    expect(() => createBahithAuth(parseAuthConfig(env))).toThrow(AuthConfigError);
  });
  it.each([
    { AUTH_DATABASE_URL: 'postgresql://bahith_app@localhost/bahith' },
    { BETTER_AUTH_SECRET: 'short' },
    { BETTER_AUTH_URL: 'http://untrusted.example.test' },
    { BETTER_AUTH_URL: 'https://example.test/nested' },
    { GOOGLE_CLIENT_ID: 'incomplete' },
    { SMTP_HOST: 'localhost' },
    { SMTP_HOST: 'localhost', SMTP_FROM: 'valid@example.test', SMTP_USER: 'incomplete' },
  ])('rejects incomplete or unsafe config without echoing its values (%#)', (override) => {
    expect(() => parseAuthConfig({ ...validEnv(), ...override })).toThrow(AuthConfigError);
  });
  it('preserves explicit SMTP delivery and optional matched Google credentials', () => {
    const config = parseAuthConfig({
      ...validEnv(),
      SMTP_HOST: 'localhost',
      SMTP_PORT: '1025',
      SMTP_FROM: 'sender@example.test',
      SMTP_SECURE: 'false',
      GOOGLE_CLIENT_ID: 'test-client-id',
      GOOGLE_CLIENT_SECRET: 'test-provider-fixture',
    });
    expect(config.smtp).toEqual({
      host: 'localhost',
      port: 1025,
      secure: false,
      from: 'sender@example.test',
    });
    expect(config.google?.clientId).toBe('test-client-id');
  });
  it.each(['/callback/google', '/oauth2/callback/google', '/sign-in/social'])(
    'blocks social session creation bypassing local two factor: %s',
    async (path) => {
      expect(isSocialSessionPath(path)).toBe(true);
      await expect(
        enforceSocialSecondFactor(path, crypto.randomUUID(), () => Promise.resolve(true)),
      ).rejects.toMatchObject({ body: { code: 'AUTH_OAUTH_2FA_REQUIRED' } });
    },
  );
  it('keeps credential TOTP handling in the library and permits social login without local TOTP', async () => {
    await expect(
      enforceSocialSecondFactor('/sign-in/email', crypto.randomUUID(), () => Promise.resolve(true)),
    ).resolves.toBeUndefined();
    await expect(
      enforceSocialSecondFactor('/callback/google', crypto.randomUUID(), () =>
        Promise.resolve(false),
      ),
    ).resolves.toBeUndefined();
  });
});
