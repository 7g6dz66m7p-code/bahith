import { createDatabase, schema } from '@bahith/db';
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { phoneNumber, twoFactor } from 'better-auth/plugins';
import { z } from 'zod';

import type { AuthConfig } from './config';
import { AuthConfigError } from './config';
import type { AuthMailTransport } from './mail';
import { createAuthMailTransport } from './mail';
import { enforceSocialSecondFactor } from './oauth-policy';
import type { SmsSender } from './sms';
import { createSmsSender, isE164, SmsUnavailableError } from './sms';

export interface CreateBahithAuthOptions {
  /** Trusted server dependency, never a browser-supplied transport. */
  mailTransport?: AuthMailTransport;
  /** SMS delivery for phone OTP; defaults to the environment's configured sender (or none). */
  smsSender?: SmsSender | null;
}

/**
 * Private identity service. Auth DB credentials must use bahith_auth; research
 * requests use bahith_app separately. Workspace creation is atomic in the users
 * INSERT trigger, rather than a Better Auth after-hook (which runs after commit).
 *
 * Framework independent: bind `auth.handler` or `toNextJsHandler(auth)` in the app.
 */
export function createBahithAuth(config: AuthConfig, options: CreateBahithAuthOptions = {}) {
  const mail =
    options.mailTransport ?? (config.smtp ? createAuthMailTransport(config.smtp) : undefined);
  if (mail === undefined) throw new AuthConfigError(['SMTP_HOST', 'SMTP_FROM']);
  const database = createDatabase({ connectionString: config.databaseUrl });
  const sms =
    options.smsSender === undefined
      ? createSmsSender(process.env, config.baseUrl)
      : options.smsSender;

  const auth = betterAuth({
    appName: 'BAHITH',
    baseURL: config.baseUrl,
    basePath: '/api/auth',
    secret: config.secret,
    trustedOrigins: [config.baseUrl],
    database: drizzleAdapter(database.db, {
      provider: 'pg',
      schema: schema.authSchema,
      transaction: true,
    }),
    // Better Auth's default logger can include request errors. App boundaries map
    // stable auth error codes; this package emits no secret-bearing log payloads.
    logger: { disabled: true },
    advanced: {
      database: { generateId: 'uuid' },
      cookiePrefix: 'bahith',
      useSecureCookies: new URL(config.baseUrl).protocol === 'https:',
      disableCSRFCheck: false,
      disableOriginCheck: false,
      defaultCookieAttributes: { httpOnly: true, sameSite: 'lax' },
    },
    emailAndPassword: {
      enabled: true,
      requireEmailVerification: true,
      autoSignIn: false,
      minPasswordLength: 12,
      maxPasswordLength: 128,
      resetPasswordTokenExpiresIn: 3600,
      revokeSessionsOnPasswordReset: true,
      async sendResetPassword({ user, url }) {
        await mail.send({
          to: user.email,
          subject: 'باحث | BAHITH — استعادة كلمة المرور / Reset your password',
          text: `استعادة كلمة المرور / Reset your password:\n${url}`,
        });
      },
    },
    emailVerification: {
      sendOnSignUp: true,
      sendOnSignIn: true,
      autoSignInAfterVerification: false,
      expiresIn: 3600,
      async sendVerificationEmail({ user, url }) {
        await mail.send({
          to: user.email,
          subject: 'باحث | BAHITH — تأكيد البريد / Verify your email',
          text: `تأكيد البريد الإلكتروني / Verify your email:\n${url}`,
        });
      },
    },
    user: {
      additionalFields: {
        locale: {
          type: ['ar', 'en'],
          required: false,
          defaultValue: 'ar',
          input: true,
          validator: { input: z.enum(['ar', 'en']) },
        },
      },
    },
    account: {
      accountLinking: {
        enabled: true,
        disableImplicitLinking: true,
        allowDifferentEmails: false,
      },
    },
    session: {
      expiresIn: 7 * 24 * 60 * 60,
      updateAge: 24 * 60 * 60,
      freshAge: 60 * 60,
      cookieCache: { enabled: false },
    },
    verification: { storeIdentifier: 'hashed', storeInDatabase: true },
    rateLimit: {
      enabled: true,
      storage: 'database',
      window: 60,
      max: 100,
      customRules: {
        '/sign-in/email': { window: 60, max: 10 },
        '/sign-up/email': { window: 60, max: 5 },
        '/request-password-reset': { window: 60, max: 3 },
        '/send-verification-email': { window: 60, max: 3 },
        // Each OTP costs an SMS and invites abuse: few sends, few attempts.
        '/phone-number/send-otp': { window: 600, max: 3 },
        '/phone-number/verify': { window: 600, max: 10 },
      },
    },
    ...(config.google
      ? { socialProviders: { google: { ...config.google, requireEmailVerification: true } } }
      : {}),
    databaseHooks: {
      session: {
        create: {
          async before(session, ctx) {
            await enforceSocialSecondFactor(ctx?.path, session.userId, async (userId) => {
              const result = await database.pool.query(
                'select two_factor_enabled from users where id = $1',
                [userId],
              );
              const rows = z
                .array(z.object({ two_factor_enabled: z.boolean() }))
                .parse(result.rows);
              return rows[0]?.two_factor_enabled === true;
            });
            return { data: session };
          },
        },
      },
    },
    plugins: [
      {
        id: 'bahith-origin-guard',
        async onRequest(request) {
          // The phone plugin is used only to attach and verify a phone on a signed-in
          // account. Signing in or resetting a password by SMS alone would bypass the
          // password and the second factor, so those routes are closed.
          const route = new URL(request.url).pathname.replace(/^.*\/api\/auth/u, '');
          if (
            route === '/sign-in/phone-number' ||
            route.startsWith('/phone-number/request-password-reset') ||
            route.startsWith('/phone-number/reset-password')
          ) {
            return { response: Response.json({ code: 'AUTH_ROUTE_DISABLED' }, { status: 404 }) };
          }
          if (route === '/phone-number/verify' && request.method === 'POST') {
            const body = (await request
              .clone()
              .json()
              .catch(() => null)) as {
              updatePhoneNumber?: unknown;
            } | null;
            if (body?.updatePhoneNumber !== true) {
              return { response: Response.json({ code: 'AUTH_ROUTE_DISABLED' }, { status: 404 }) };
            }
          }
          if (
            !['GET', 'HEAD', 'OPTIONS'].includes(request.method) &&
            request.headers.get('origin') !== config.baseUrl
          ) {
            return { response: Response.json({ code: 'AUTH_INVALID_ORIGIN' }, { status: 403 }) };
          }
          return undefined;
        },
      },
      twoFactor({ issuer: 'BAHITH', skipVerificationOnEnable: false }),
      phoneNumber({
        otpLength: 6,
        expiresIn: 300,
        allowedAttempts: 5,
        phoneNumberValidator: (value) => isE164(value),
        async sendOTP({ phoneNumber: number, code }) {
          if (sms === null) throw new SmsUnavailableError();
          await sms.sendOtp(number, code);
        },
      }),
    ],
  });

  return {
    auth,
    async close(): Promise<void> {
      mail.close?.();
      await database.close();
    },
  };
}

export type BahithAuth = ReturnType<typeof createBahithAuth>['auth'];
export type BahithAuthService = ReturnType<typeof createBahithAuth>;
