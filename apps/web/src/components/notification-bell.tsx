import { useTranslations } from 'next-intl';

import { Link } from '@/i18n/navigation';

/** Header link to the notifications page, with the unread count. */
export function NotificationBell({ count }: { count: number }) {
  const t = useTranslations('Notifications');
  return (
    <Link
      href="/notifications"
      className="inline-flex items-center gap-2 text-sm underline underline-offset-4"
      aria-label={count > 0 ? t('bellUnread', { count }) : t('bell')}
      data-testid="notification-bell"
    >
      <svg
        aria-hidden="true"
        viewBox="0 0 24 24"
        className="size-4"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
        <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
      </svg>
      <span>{t('bell')}</span>
      {/* The count is drawn by CSS from data-count, so the link's visible text stays "the
          bell" and its spoken name (aria-label) contains it (WCAG 2.5.3 Label in Name). */}
      {count > 0 ? (
        <span
          className="notification-count"
          aria-hidden="true"
          data-testid="notification-count"
          data-count={count > 99 ? t('manyUnread') : String(count)}
        />
      ) : null}
    </Link>
  );
}
