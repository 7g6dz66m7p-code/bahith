'use client';

import { useTranslations } from 'next-intl';
import type { SubmitEvent } from 'react';
import { useState } from 'react';

import { useRouter } from '@/i18n/navigation';
import { authClient } from '@/lib/auth-client';

const E164 = /^\+[1-9][0-9]{6,14}$/u;

function field(form: HTMLFormElement, name: string): string {
  const value = new FormData(form).get(name);
  return typeof value === 'string' ? value : '';
}

/**
 * Attaches a verified phone number to the signed-in account by SMS one-time code.
 * The server refuses phone sign-in and SMS password reset; this only proves ownership.
 */
export function PhoneVerification({
  phoneNumber,
  verified,
  smsAvailable,
}: {
  phoneNumber: string | null;
  verified: boolean;
  smsAvailable: boolean;
}) {
  const t = useTranslations('Phone');
  const router = useRouter();
  const [number, setNumber] = useState(phoneNumber ?? '');
  const [codeSent, setCodeSent] = useState(false);
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState<{ kind: 'error' | 'success'; text: string } | null>(null);

  const send = async (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    const value = field(event.currentTarget, 'phone').replace(/[\s-]/gu, '');
    if (!E164.test(value)) {
      setNotice({ kind: 'error', text: t('invalidNumber') });
      return;
    }
    setPending(true);
    setNotice(null);
    try {
      const result = await authClient.phoneNumber.sendOtp({ phoneNumber: value });
      if (result.error) {
        setNotice({
          kind: 'error',
          text: t(result.error.status === 429 ? 'tooManyRequests' : 'sendFailed'),
        });
        return;
      }
      setNumber(value);
      setCodeSent(true);
      setNotice({ kind: 'success', text: t('codeSent') });
    } catch {
      setNotice({ kind: 'error', text: t('sendFailed') });
    } finally {
      setPending(false);
    }
  };

  const verify = async (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    const code = field(event.currentTarget, 'code').trim();
    setPending(true);
    setNotice(null);
    try {
      const result = await authClient.phoneNumber.verify({
        phoneNumber: number,
        code,
        updatePhoneNumber: true,
      });
      if (result.error) {
        setNotice({ kind: 'error', text: t('invalidCode') });
        return;
      }
      setCodeSent(false);
      setNotice({ kind: 'success', text: t('verifiedSuccess') });
      router.refresh();
    } catch {
      setNotice({ kind: 'error', text: t('invalidCode') });
    } finally {
      setPending(false);
    }
  };

  return (
    <section className="surface space-y-4 p-5 sm:p-6" aria-labelledby="phone-title">
      <h2 className="section-title" id="phone-title">
        {t('title')}
      </h2>
      <p className="muted text-sm">{t('description')}</p>
      <p className="text-sm" data-testid="phone-status">
        {verified && phoneNumber !== null ? (
          <>
            {t('verified')} <span dir="ltr">{phoneNumber}</span>
          </>
        ) : (
          t('notVerified')
        )}
      </p>
      {notice === null ? null : (
        <p
          className={notice.kind === 'error' ? 'error-text' : 'text-sm'}
          role={notice.kind === 'error' ? 'alert' : 'status'}
          data-testid={`phone-${notice.kind}`}
        >
          {notice.text}
        </p>
      )}
      {!smsAvailable ? (
        <p className="text-sm" role="status" data-testid="sms-unavailable">
          {t('unavailable')}
        </p>
      ) : codeSent ? (
        <form method="post" className="space-y-3" onSubmit={(event) => void verify(event)}>
          <label className="block space-y-1">
            <span className="text-sm font-medium">{t('code')}</span>
            <input
              name="code"
              className="field"
              dir="ltr"
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="[0-9]{6}"
              maxLength={6}
              required
            />
          </label>
          <div className="flex flex-wrap gap-3">
            <button className="btn" type="submit" disabled={pending}>
              {t('verify')}
            </button>
            <button
              className="btn-secondary"
              type="button"
              disabled={pending}
              onClick={() => {
                setCodeSent(false);
              }}
            >
              {t('changeNumber')}
            </button>
          </div>
        </form>
      ) : (
        <form method="post" className="space-y-3" onSubmit={(event) => void send(event)}>
          <label className="block space-y-1">
            <span className="text-sm font-medium">{t('number')}</span>
            <input
              name="phone"
              type="tel"
              className="field"
              dir="ltr"
              autoComplete="tel"
              placeholder="+9647XXXXXXXXX"
              defaultValue={number}
              maxLength={20}
              required
            />
            <span className="muted block text-xs">{t('numberHint')}</span>
          </label>
          <button className="btn" type="submit" disabled={pending}>
            {t('sendCode')}
          </button>
        </form>
      )}
    </section>
  );
}
