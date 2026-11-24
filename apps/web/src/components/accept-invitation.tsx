'use client';

import { useTranslations } from 'next-intl';
import { useState } from 'react';

import { Link } from '@/i18n/navigation';

const ERRORS = {
  INVITATION_INVALID: 'errorInvalid',
  INVITATION_EXPIRED: 'errorExpired',
  INVITATION_EMAIL_MISMATCH: 'errorMismatch',
} as const;

/** Reads the token from the URL fragment (never sent to the server) and accepts it. */
export function AcceptInvitation() {
  const t = useTranslations('Invitation');
  const roles = useTranslations('Members');
  const [missing, setMissing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [joined, setJoined] = useState<string | null>(null);

  const accept = async () => {
    const token = window.location.hash.slice(1);
    if (token === '') {
      setMissing(true);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const response = await fetch('/api/invitations/accept', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token }),
      });
      const payload = (await response.json().catch(() => ({}))) as { code?: string; role?: string };
      if (!response.ok) {
        const code = payload.code;
        setError(
          t(
            typeof code === 'string' && code in ERRORS
              ? ERRORS[code as keyof typeof ERRORS]
              : 'errorGeneric',
          ),
        );
        return;
      }
      const role = payload.role;
      setJoined(
        role === 'editor' || role === 'viewer' || role === 'supervisor' || role === 'owner'
          ? roles(role)
          : '',
      );
      window.history.replaceState(null, '', window.location.pathname);
    } catch {
      setError(t('errorGeneric'));
    } finally {
      setBusy(false);
    }
  };

  if (joined !== null) {
    return (
      <div className="space-y-4">
        <p role="status">{t('joined', { role: joined })}</p>
        <Link className="btn" href="/dashboard">
          {t('open')}
        </Link>
      </div>
    );
  }
  return (
    <div className="space-y-4">
      {missing ? <p className="error-text">{t('missing')}</p> : null}
      {error === null ? null : (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}
      <button className="btn" type="button" disabled={busy} onClick={() => void accept()}>
        {t(busy ? 'accepting' : 'accept')}
      </button>
    </div>
  );
}
