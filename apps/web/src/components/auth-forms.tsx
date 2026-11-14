'use client';

import { useLocale, useTranslations } from 'next-intl';
import type { SubmitEvent, ReactNode } from 'react';
import { useState } from 'react';

import { LocaleSwitcher } from '@/components/locale-switcher';
import { Link, useRouter } from '@/i18n/navigation';
import { authClient } from '@/lib/auth-client';

function formText(data: FormData, key: string, fallback = ''): string {
  const value = data.get(key);
  return typeof value === 'string' ? value : fallback;
}

type AuthTitle =
  'signInTitle' | 'signUpTitle' | 'forgotTitle' | 'resetTitle' | 'verifyTitle' | 'twoFactorTitle';
type AuthDescription =
  | 'signInDescription'
  | 'signUpDescription'
  | 'forgotDescription'
  | 'resetDescription'
  | 'verifyDescription'
  | 'twoFactorDescription';

export function AuthPageFrame({
  title,
  description,
  children,
}: {
  title: AuthTitle;
  description: AuthDescription;
  children: ReactNode;
}) {
  const t = useTranslations('Auth');
  return (
    <main className="app-shell mx-auto flex min-h-dvh w-full max-w-xl flex-col justify-center gap-6 px-5 py-10">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <Link className="text-sm underline underline-offset-4" href="/">
          {t('home')}
        </Link>
        <LocaleSwitcher />
      </div>
      <section className="surface space-y-6 p-6 sm:p-8" aria-labelledby="auth-title">
        <header className="space-y-3">
          <h1 id="auth-title" className="text-3xl font-bold tracking-tight">
            {t(title)}
          </h1>
          <p className="muted leading-relaxed">{t(description)}</p>
        </header>
        {children}
      </section>
    </main>
  );
}

function Feedback({ error, message }: { error: string; message: string }) {
  return (
    <>
      {error ? (
        <p className="error-text" role="alert">
          {error}
        </p>
      ) : null}
      {message ? (
        <p className="success-text" role="status">
          {message}
        </p>
      ) : null}
    </>
  );
}

function GoogleSignIn({ enabled }: { enabled: boolean }) {
  const t = useTranslations('Auth');
  const locale = useLocale();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  if (!enabled) return null;
  return (
    <div className="space-y-3 border-t border-border pt-5">
      <button
        type="button"
        className="btn-secondary w-full"
        disabled={pending}
        onClick={() => {
          setPending(true);
          setError('');
          void authClient.signIn
            .social({ provider: 'google', callbackURL: `/${locale}/dashboard` })
            .then((result) => {
              if (result.error) setError(t('genericError'));
            })
            .catch(() => {
              setError(t('genericError'));
            })
            .finally(() => {
              setPending(false);
            });
        }}
      >
        {pending ? t('busy') : t('googleSignIn')}
      </button>
      <p className="muted text-sm">{t('googleTwoFactorHint')}</p>
      <Feedback error={error} message="" />
    </div>
  );
}

export function SignInForm({ googleEnabled = false }: { googleEnabled?: boolean }) {
  const t = useTranslations('Auth');
  const locale = useLocale();
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const submit = async (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    setPending(true);
    setError('');
    try {
      const result = await authClient.signIn.email({
        email: formText(data, 'email'),
        password: formText(data, 'password'),
        callbackURL: `/${locale}/dashboard`,
      });
      if (result.error) {
        setError(
          t(result.error.code === 'EMAIL_NOT_VERIFIED' ? 'verificationRequired' : 'signInError'),
        );
      } else if ('twoFactorRedirect' in result.data && result.data.twoFactorRedirect) {
        router.push('/two-factor');
      } else {
        router.replace('/dashboard');
        router.refresh();
      }
    } catch {
      setError(t('signInError'));
    } finally {
      setPending(false);
    }
  };
  return (
    <>
      <form
        className="space-y-5"
        onSubmit={(event) => {
          void submit(event);
        }}
      >
        <label className="block space-y-2">
          <span>{t('email')}</span>
          <input
            className="field"
            name="email"
            type="email"
            autoComplete="email"
            required
            maxLength={254}
            dir="ltr"
          />
        </label>
        <label className="block space-y-2">
          <span>{t('password')}</span>
          <input
            className="field"
            name="password"
            type="password"
            autoComplete="current-password"
            required
            maxLength={128}
          />
        </label>
        <Feedback error={error} message="" />
        <button type="submit" className="btn w-full" disabled={pending}>
          {pending ? t('busy') : t('signIn')}
        </button>
      </form>
      <div className="flex flex-wrap justify-between gap-3 text-sm">
        <Link href="/forgot-password" className="underline underline-offset-4">
          {t('forgotPassword')}
        </Link>
        <Link href="/verify-email" className="underline underline-offset-4">
          {t('resendVerification')}
        </Link>
      </div>
      <p className="text-sm">
        <Link href="/sign-up" className="underline underline-offset-4">
          {t('noAccount')}
        </Link>
      </p>
      <GoogleSignIn enabled={googleEnabled} />
    </>
  );
}

export function SignUpForm({ googleEnabled = false }: { googleEnabled?: boolean }) {
  const t = useTranslations('Auth');
  const locale = useLocale();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const submit = async (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const password = formText(data, 'password');
    if (password !== formText(data, 'confirmPassword')) {
      setError(t('passwordMismatch'));
      return;
    }
    setPending(true);
    setError('');
    setMessage('');
    try {
      const result = await authClient.signUp.email({
        email: formText(data, 'email'),
        name: formText(data, 'name').trim(),
        password,
        locale,
        callbackURL: `/${locale}/dashboard`,
      });
      if (result.error) setError(t('genericError'));
      else {
        form.reset();
        setMessage(t('signUpSuccess'));
      }
    } catch {
      setError(t('genericError'));
    } finally {
      setPending(false);
    }
  };
  return (
    <>
      <form
        className="space-y-5"
        onSubmit={(event) => {
          void submit(event);
        }}
      >
        <label className="block space-y-2">
          <span>{t('name')}</span>
          <input
            className="field"
            name="name"
            type="text"
            autoComplete="name"
            required
            minLength={2}
            maxLength={100}
            dir="auto"
          />
        </label>
        <label className="block space-y-2">
          <span>{t('email')}</span>
          <input
            className="field"
            name="email"
            type="email"
            autoComplete="email"
            required
            maxLength={254}
            dir="ltr"
          />
        </label>
        <label className="block space-y-2">
          <span>{t('password')}</span>
          <input
            className="field"
            name="password"
            type="password"
            autoComplete="new-password"
            required
            minLength={12}
            maxLength={128}
            aria-describedby="password-hint"
          />
        </label>
        <p id="password-hint" className="muted text-sm">
          {t('passwordHint')}
        </p>
        <label className="block space-y-2">
          <span>{t('confirmPassword')}</span>
          <input
            className="field"
            name="confirmPassword"
            type="password"
            autoComplete="new-password"
            required
            minLength={12}
            maxLength={128}
          />
        </label>
        <Feedback error={error} message={message} />
        <button type="submit" className="btn w-full" disabled={pending}>
          {pending ? t('busy') : t('signUp')}
        </button>
      </form>
      <p className="text-sm">
        <Link href="/sign-in" className="underline underline-offset-4">
          {t('haveAccount')}
        </Link>
      </p>
      <GoogleSignIn enabled={googleEnabled} />
    </>
  );
}

export function EmailRequestForm({ kind }: { kind: 'reset' | 'verification' }) {
  const t = useTranslations('Auth');
  const locale = useLocale();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const submit = async (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const email = formText(data, 'email');
    setPending(true);
    setError('');
    setMessage('');
    try {
      const result =
        kind === 'reset'
          ? await authClient.requestPasswordReset({
              email,
              redirectTo: `/${locale}/reset-password`,
            })
          : await authClient.sendVerificationEmail({ email, callbackURL: `/${locale}/dashboard` });
      if (result.error && (result.error.status === 429 || result.error.status >= 500))
        setError(t('genericError'));
      else setMessage(t(kind === 'reset' ? 'resetSent' : 'verificationSent'));
    } catch {
      setError(t('genericError'));
    } finally {
      setPending(false);
    }
  };
  return (
    <>
      <form
        className="space-y-5"
        onSubmit={(event) => {
          void submit(event);
        }}
      >
        <label className="block space-y-2">
          <span>{t('email')}</span>
          <input
            className="field"
            name="email"
            type="email"
            autoComplete="email"
            required
            maxLength={254}
            dir="ltr"
          />
        </label>
        <Feedback error={error} message={message} />
        <button className="btn w-full" type="submit" disabled={pending}>
          {pending ? t('busy') : t(kind === 'reset' ? 'sendReset' : 'resendVerification')}
        </button>
      </form>
      <Link href="/sign-in" className="inline-block text-sm underline underline-offset-4">
        {t('backSignIn')}
      </Link>
    </>
  );
}

export function ResetPasswordForm({ token }: { token: string | null }) {
  const t = useTranslations('Auth');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const submit = async (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (token === null) return;
    const form = event.currentTarget;
    const data = new FormData(form);
    const password = formText(data, 'password');
    if (password !== formText(data, 'confirmPassword')) {
      setError(t('passwordMismatch'));
      return;
    }
    setPending(true);
    setError('');
    setMessage('');
    try {
      const result = await authClient.resetPassword({ newPassword: password, token });
      if (result.error) setError(t('invalidReset'));
      else {
        form.reset();
        setMessage(t('resetSuccess'));
      }
    } catch {
      setError(t('genericError'));
    } finally {
      setPending(false);
    }
  };
  return (
    <>
      {token === null ? (
        <p className="error-text" role="alert">
          {t('invalidReset')}
        </p>
      ) : (
        <form
          className="space-y-5"
          onSubmit={(event) => {
            void submit(event);
          }}
        >
          <label className="block space-y-2">
            <span>{t('password')}</span>
            <input
              className="field"
              name="password"
              type="password"
              autoComplete="new-password"
              required
              minLength={12}
              maxLength={128}
              aria-describedby="reset-password-hint"
            />
          </label>
          <p id="reset-password-hint" className="muted text-sm">
            {t('passwordHint')}
          </p>
          <label className="block space-y-2">
            <span>{t('confirmPassword')}</span>
            <input
              className="field"
              name="confirmPassword"
              type="password"
              autoComplete="new-password"
              required
              minLength={12}
              maxLength={128}
            />
          </label>
          <Feedback error={error} message={message} />
          <button className="btn w-full" type="submit" disabled={pending}>
            {pending ? t('busy') : t('resetPassword')}
          </button>
        </form>
      )}
      <Link href="/sign-in" className="inline-block text-sm underline underline-offset-4">
        {t('backSignIn')}
      </Link>
    </>
  );
}

export function TwoFactorForm() {
  const t = useTranslations('Auth');
  const router = useRouter();
  const [backup, setBackup] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const submit = async (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const code = formText(data, 'code').trim();
    setPending(true);
    setError('');
    try {
      const result = backup
        ? await authClient.twoFactor.verifyBackupCode({ code })
        : await authClient.twoFactor.verifyTotp({
            code,
            trustDevice: data.get('trustDevice') === 'on',
          });
      if (result.error) setError(t('challengeError'));
      else {
        router.replace('/dashboard');
        router.refresh();
      }
    } catch {
      setError(t('challengeError'));
    } finally {
      setPending(false);
    }
  };
  return (
    <>
      <form
        className="space-y-5"
        onSubmit={(event) => {
          void submit(event);
        }}
      >
        <label className="block space-y-2">
          <span>{t(backup ? 'backupCode' : 'totpCode')}</span>
          <input
            key={backup ? 'backup' : 'totp'}
            className="field"
            name="code"
            type="text"
            required
            inputMode={backup ? 'text' : 'numeric'}
            pattern={backup ? undefined : '[0-9]{6}'}
            minLength={backup ? 4 : 6}
            maxLength={backup ? 128 : 6}
            autoComplete="one-time-code"
            dir="ltr"
          />
        </label>
        {!backup ? (
          <label className="flex items-center gap-3">
            <input name="trustDevice" type="checkbox" />
            <span>{t('trustDevice')}</span>
          </label>
        ) : null}
        <Feedback error={error} message="" />
        <button className="btn w-full" type="submit" disabled={pending}>
          {pending ? t('busy') : t('verifyCode')}
        </button>
      </form>
      <button
        type="button"
        className="btn-secondary w-full"
        disabled={pending}
        onClick={() => {
          setBackup(!backup);
          setError('');
        }}
      >
        {t(backup ? 'useAuthenticator' : 'useBackupCode')}
      </button>
      <Link href="/sign-in" className="inline-block text-sm underline underline-offset-4">
        {t('backSignIn')}
      </Link>
    </>
  );
}
