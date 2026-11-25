'use client';

import { useFormatter, useTranslations } from 'next-intl';
import type { SubmitEvent } from 'react';
import { useState } from 'react';

import { Link, useRouter } from '@/i18n/navigation';

type Role = 'owner' | 'editor' | 'viewer' | 'supervisor';
const ROLES: Role[] = ['owner', 'editor', 'viewer', 'supervisor'];

export interface MemberView {
  userId: string;
  role: Role;
  email: string | null;
  isYou: boolean;
}
export interface InvitationView {
  id: string;
  email: string;
  role: Role;
  expiresAt: string;
}

const ERRORS = {
  MEMBER_FORBIDDEN: 'errorForbidden',
  MEMBER_LAST_OWNER: 'errorLastOwner',
  MEMBER_INVALID_INPUT: 'errorInvalid',
} as const;

/** Members, roles and invitations of one workspace; mutations are owner-only server-side. */
export function MembersPanel({
  workspaceId,
  locale,
  members,
  invitations,
}: {
  workspaceId: string;
  locale: 'ar' | 'en';
  members: MemberView[];
  invitations: InvitationView[];
}) {
  const t = useTranslations('Members');
  const format = useFormatter();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ kind: 'error' | 'success'; text: string } | null>(null);
  const [link, setLink] = useState<string | null>(null);
  const isOwner = members.some((member) => member.isYou && member.role === 'owner');
  const base = `/api/workspaces/${workspaceId}`;

  const call = async (url: string, init: RequestInit): Promise<Record<string, unknown> | null> => {
    setBusy(true);
    setNotice(null);
    try {
      const response = await fetch(url, {
        ...init,
        headers: { 'Content-Type': 'application/json' },
      });
      const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
      if (!response.ok) {
        const code = payload.code;
        setNotice({
          kind: 'error',
          text: t(
            typeof code === 'string' && code in ERRORS
              ? ERRORS[code as keyof typeof ERRORS]
              : 'errorGeneric',
          ),
        });
        return null;
      }
      return payload;
    } catch {
      setNotice({ kind: 'error', text: t('errorGeneric') });
      return null;
    } finally {
      setBusy(false);
    }
  };

  const invite = async (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const result = await call(`${base}/members`, {
      method: 'POST',
      body: JSON.stringify({ email: data.get('email'), role: data.get('role'), locale }),
    });
    if (result === null) return;
    setLink(typeof result.link === 'string' ? result.link : null);
    setNotice({
      kind: 'success',
      text: t(result.emailSent === true ? 'invited' : 'invitedNoMail'),
    });
    form.reset();
    router.refresh();
  };

  return (
    <div className="space-y-6">
      {notice === null ? null : (
        <p
          className={notice.kind === 'error' ? 'error-text' : 'text-sm'}
          role={notice.kind === 'error' ? 'alert' : 'status'}
        >
          {notice.text}
        </p>
      )}
      <section className="surface space-y-4 p-5 sm:p-6" aria-labelledby="members-list">
        <h2 className="section-title" id="members-list">
          {t('title')}
        </h2>
        <ul className="space-y-3">
          {members.map((member) => {
            const label = member.isYou ? t('you') : (member.email ?? t('founder'));
            return (
              <li
                key={member.userId}
                className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border p-4"
                data-testid="member"
              >
                <span dir="auto" className="min-w-0 break-all font-medium">
                  {label}
                </span>
                <span className="flex flex-wrap items-center gap-3">
                  {isOwner ? (
                    <select
                      className="field w-auto"
                      aria-label={t('roleFor', { member: label })}
                      value={member.role}
                      disabled={busy}
                      onChange={(event) =>
                        void call(`${base}/members/${member.userId}`, {
                          method: 'PATCH',
                          body: JSON.stringify({ role: event.target.value }),
                        }).then((ok) => {
                          if (ok !== null) router.refresh();
                        })
                      }
                    >
                      {ROLES.map((role) => (
                        <option key={role} value={role}>
                          {t(role)}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <span className="muted text-sm">{t(member.role)}</span>
                  )}
                  {isOwner || member.isYou ? (
                    <button
                      className="btn-secondary"
                      type="button"
                      disabled={busy}
                      onClick={() =>
                        void call(`${base}/members/${member.userId}`, { method: 'DELETE' }).then(
                          (ok) => {
                            if (ok === null) return;
                            if (member.isYou) router.push('/dashboard');
                            else router.refresh();
                          },
                        )
                      }
                    >
                      {member.isYou ? t('leave') : t('remove')}
                    </button>
                  ) : null}
                </span>
              </li>
            );
          })}
        </ul>
      </section>

      {isOwner ? (
        <section className="surface space-y-4 p-5 sm:p-6" aria-labelledby="invite-title">
          <h2 className="section-title" id="invite-title">
            {t('inviteTitle')}
          </h2>
          <form
            method="post"
            className="grid gap-3 sm:grid-cols-[1fr_12rem_auto] sm:items-end"
            onSubmit={(event) => void invite(event)}
          >
            <div className="space-y-1">
              <label className="block text-sm font-medium" htmlFor="invite-email">
                {t('email')}
              </label>
              <input
                id="invite-email"
                name="email"
                type="email"
                required
                dir="ltr"
                className="field"
                maxLength={320}
              />
            </div>
            <div className="space-y-1">
              <label className="block text-sm font-medium" htmlFor="invite-role">
                {t('role')}
              </label>
              <select id="invite-role" name="role" className="field" defaultValue="editor">
                {ROLES.filter((role) => role !== 'owner').map((role) => (
                  <option key={role} value={role}>
                    {t(role)}
                  </option>
                ))}
              </select>
            </div>
            <button className="btn" type="submit" disabled={busy}>
              {t(busy ? 'inviting' : 'invite')}
            </button>
          </form>
          {link === null ? null : (
            <label className="block space-y-1">
              <span className="text-sm font-medium">{t('link')}</span>
              <input
                className="field"
                dir="ltr"
                readOnly
                value={link}
                data-testid="invitation-link"
              />
            </label>
          )}
          <h3 className="font-semibold">{t('pending')}</h3>
          {invitations.length === 0 ? (
            <p className="muted text-sm">{t('noPending')}</p>
          ) : (
            <ul className="space-y-2">
              {invitations.map((invitation) => (
                <li
                  key={invitation.id}
                  className="flex flex-wrap items-center justify-between gap-3 text-sm"
                  data-testid="invitation"
                >
                  <span dir="ltr" className="break-all">
                    {invitation.email}
                  </span>
                  <span className="muted">
                    {t('pendingMeta', {
                      role: t(invitation.role),
                      date: format.dateTime(new Date(invitation.expiresAt), {
                        dateStyle: 'medium',
                      }),
                    })}
                  </span>
                  <button
                    className="btn-secondary"
                    type="button"
                    disabled={busy}
                    onClick={() =>
                      void call(`${base}/invitations/${invitation.id}`, { method: 'DELETE' }).then(
                        (ok) => {
                          if (ok !== null) router.refresh();
                        },
                      )
                    }
                  >
                    {t('revoke')}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      ) : null}
      <Link className="underline underline-offset-4" href="/dashboard">
        {t('back')}
      </Link>
    </div>
  );
}
