'use client';

import type { NotificationEntry } from '@bahith/db';
import { useLocale, useTranslations } from 'next-intl';
import type { ReactNode } from 'react';
import { useState } from 'react';

import { Link, useRouter } from '@/i18n/navigation';

/** Where a notification leads: the draft, the project, or the workspace's members. */
function targetOf(entry: NotificationEntry): {
  href: string;
  label: 'openDraft' | 'openProject' | 'openMembers';
} {
  const workspace = `/workspaces/${entry.workspaceId}`;
  if (entry.projectId !== null && entry.entityType === 'document') {
    return {
      href: `${workspace}/projects/${entry.projectId}/documents/${entry.entityId}`,
      label: 'openDraft',
    };
  }
  if (entry.projectId !== null) {
    return { href: `${workspace}/projects/${entry.projectId}`, label: 'openProject' };
  }
  return { href: `${workspace}/members`, label: 'openMembers' };
}

export function NotificationsPanel({
  initial,
  initialUnread,
}: {
  initial: NotificationEntry[];
  initialUnread: number;
}) {
  const t = useTranslations('Notifications');
  const locale = useLocale();
  const router = useRouter();
  const [items, setItems] = useState(initial);
  const [unread, setUnread] = useState(initialUnread);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<'allRead' | 'markError' | null>(null);

  const post = (body: { ids: string[] } | { all: true }) =>
    fetch('/api/notifications/read', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      keepalive: true,
    });

  const markAll = async () => {
    setBusy(true);
    setMessage(null);
    try {
      const response = await post({ all: true });
      if (!response.ok) {
        setMessage('markError');
        return;
      }
      const now = new Date().toISOString();
      setItems((current) => current.map((item) => ({ ...item, readAt: item.readAt ?? now })));
      setUnread(0);
      setMessage('allRead');
      router.refresh();
    } catch {
      setMessage('markError');
    } finally {
      setBusy(false);
    }
  };

  /** Opening an unread notification marks it read (best effort; the link still opens). */
  const markOne = (entry: NotificationEntry) => {
    if (entry.readAt !== null) return;
    void post({ ids: [entry.id] }).catch(() => undefined);
  };

  const date = new Intl.DateTimeFormat(locale, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'Asia/Baghdad',
  });
  const name = (chunks: ReactNode) => <bdi>{chunks}</bdi>;

  return (
    <section className="space-y-4" aria-labelledby="notifications-list-title">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <h2 className="section-title" id="notifications-list-title">
          {unread > 0 ? t('unreadCount', { count: unread }) : t('noUnread')}
        </h2>
        <button
          type="button"
          className="btn-secondary"
          disabled={busy || unread === 0}
          onClick={() => {
            void markAll();
          }}
        >
          {t(busy ? 'marking' : 'markAllRead')}
        </button>
      </div>
      {message === 'allRead' ? (
        <p className="success-text" role="status">
          {t('allRead')}
        </p>
      ) : null}
      {message === 'markError' ? (
        <p className="error-text" role="alert">
          {t('markError')}
        </p>
      ) : null}
      {items.length === 0 ? (
        <div className="surface p-8">
          <p className="muted">{t('empty')}</p>
        </div>
      ) : (
        <ul className="space-y-3">
          {items.map((entry) => {
            const target = targetOf(entry);
            const isUnread = entry.readAt === null;
            return (
              <li
                key={entry.id}
                className={`surface space-y-3 p-5 ${isUnread ? 'notification-unread' : ''}`}
                data-testid="notification"
                data-kind={entry.kind}
                data-read={isUnread ? 'false' : 'true'}
              >
                <p className="leading-relaxed">
                  {isUnread ? <span className="sr-only">{t('unread')}</span> : null}
                  {t.rich(`kind.${entry.kind}`, {
                    project: entry.projectTitle ?? t('unknownProject'),
                    workspace: entry.workspaceName,
                    name,
                  })}
                </p>
                <div className="muted flex flex-wrap items-center justify-between gap-3 text-sm">
                  <time dateTime={entry.createdAt}>{date.format(new Date(entry.createdAt))}</time>
                  <Link
                    href={target.href}
                    className="underline underline-offset-4"
                    onClick={() => {
                      markOne(entry);
                    }}
                  >
                    {t(target.label)}
                  </Link>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
