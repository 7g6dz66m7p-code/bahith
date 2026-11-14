'use client';

import Image from 'next/image';
import { useTranslations } from 'next-intl';
import type { SubmitEvent } from 'react';
import { useEffect, useState } from 'react';

import { Link, useRouter } from '@/i18n/navigation';
import { authClient } from '@/lib/auth-client';

function formText(data: FormData, key: string, fallback = ''): string {
  const value = data.get(key);
  return typeof value === 'string' ? value : fallback;
}

interface Enrollment {
  totpURI: string;
  backupCodes: string[];
}

export function AccountSecurity({ twoFactorEnabled }: { twoFactorEnabled: boolean }) {
  const t = useTranslations('Security');
  const router = useRouter();
  const [enabled, setEnabled] = useState(twoFactorEnabled);
  const [enrollment, setEnrollment] = useState<Enrollment | null>(null);
  const [qr, setQr] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');

  useEffect(() => {
    let active = true;
    if (enrollment === null) return;
    // Generate locally: the enrollment secret is never sent to a QR service.
    void import('qrcode')
      .then((module) =>
        module.default.toDataURL(enrollment.totpURI, {
          width: 240,
          margin: 2,
          errorCorrectionLevel: 'M',
        }),
      )
      .then((dataUrl) => {
        if (active) setQr(dataUrl);
      })
      .catch(() => {
        // Manual enrollment remains available when the local QR encoder fails.
        if (active) setQr(null);
      });
    return () => {
      active = false;
    };
  }, [enrollment]);

  const configure = async (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    const password = formText(new FormData(form), 'password');
    setPending(true);
    setError('');
    setMessage('');
    try {
      if (enabled) {
        const result = await authClient.twoFactor.disable({ password });
        if (result.error) setError(t('actionError'));
        else {
          form.reset();
          setEnabled(false);
          setEnrollment(null);
          setQr(null);
          setMessage(t('disabledSuccess'));
          router.refresh();
        }
      } else {
        const result = await authClient.twoFactor.enable({ password, method: 'totp' });
        if (result.error || result.data.method !== 'totp') setError(t('actionError'));
        else {
          form.reset();
          setQr(null);
          setEnrollment(result.data);
        }
      }
    } catch {
      setError(t('actionError'));
    } finally {
      setPending(false);
    }
  };

  const confirm = async (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    const code = formText(new FormData(event.currentTarget), 'code').trim();
    setPending(true);
    setError('');
    setMessage('');
    try {
      const result = await authClient.twoFactor.verifyTotp({ code });
      if (result.error) setError(t('actionError'));
      else {
        setEnabled(true);
        setEnrollment(null);
        setQr(null);
        setMessage(t('enabledSuccess'));
        router.refresh();
      }
    } catch {
      setError(t('actionError'));
    } finally {
      setPending(false);
    }
  };

  const setupKey =
    enrollment === null ? null : new URL(enrollment.totpURI).searchParams.get('secret');

  return (
    <section className="surface space-y-6 p-6 sm:p-8" aria-labelledby="security-title">
      <header className="space-y-3">
        <h1 id="security-title" className="text-3xl font-bold">
          {t('title')}
        </h1>
        <p className="muted leading-relaxed">{t('description')}</p>
        <p className="font-medium">{t(enabled ? 'enabled' : 'disabled')}</p>
      </header>
      {error ? (
        <p role="alert" className="error-text">
          {error}
        </p>
      ) : null}
      {message ? (
        <p role="status" className="success-text">
          {message}
        </p>
      ) : null}
      {enrollment === null ? (
        <form
          className="max-w-md space-y-5"
          onSubmit={(event) => {
            void configure(event);
          }}
        >
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
          <button type="submit" className="btn" disabled={pending}>
            {t(enabled ? 'disable' : 'enable')}
          </button>
        </form>
      ) : (
        <div className="space-y-6">
          <h2 className="section-title">{t('pendingEnrollment')}</h2>
          <p className="muted">{t('authenticatorInstructions')}</p>
          {qr ? (
            <Image
              src={qr}
              width={240}
              height={240}
              alt={t('setupUri')}
              unoptimized
              className="max-w-full rounded-lg"
            />
          ) : null}
          <label className="block space-y-2">
            <span>{t('setupKey')}</span>
            <input
              className="field font-mono"
              value={setupKey ?? ''}
              readOnly
              dir="ltr"
              autoComplete="off"
            />
          </label>
          <details className="space-y-2">
            <summary className="cursor-pointer text-sm underline underline-offset-4">
              {t('setupUri')}
            </summary>
            <p className="break-all font-mono text-xs" dir="ltr">
              {enrollment.totpURI}
            </p>
          </details>
          <section className="rounded-xl border border-border p-4" aria-labelledby="backup-title">
            <h2 className="section-title" id="backup-title">
              {t('backupCodes')}
            </h2>
            <p className="muted my-3 text-sm">{t('backupCodesHint')}</p>
            <ul className="grid grid-cols-1 gap-2 font-mono sm:grid-cols-2" dir="ltr">
              {enrollment.backupCodes.map((code) => (
                <li key={code}>
                  <code>{code}</code>
                </li>
              ))}
            </ul>
          </section>
          <form
            className="max-w-md space-y-5"
            onSubmit={(event) => {
              void confirm(event);
            }}
          >
            <label className="block space-y-2">
              <span>{t('code')}</span>
              <input
                className="field"
                name="code"
                type="text"
                inputMode="numeric"
                pattern="[0-9]{6}"
                minLength={6}
                maxLength={6}
                autoComplete="one-time-code"
                required
                dir="ltr"
              />
            </label>
            <label className="flex items-start gap-3">
              <input type="checkbox" required className="mt-1" />
              <span>{t('confirmCodesSaved')}</span>
            </label>
            <button type="submit" className="btn" disabled={pending}>
              {t('confirmEnable')}
            </button>
          </form>
        </div>
      )}
      <Link href="/dashboard" className="inline-block text-sm underline underline-offset-4">
        {t('backDashboard')}
      </Link>
    </section>
  );
}
