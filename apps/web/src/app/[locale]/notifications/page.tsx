import { listNotifications } from '@bahith/db';
import { hasLocale } from 'next-intl';
import { getTranslations } from 'next-intl/server';
import { notFound } from 'next/navigation';
import { locale as rootLocale } from 'next/root-params';

import { NotificationsPanel } from '@/components/notifications-panel';
import { Link } from '@/i18n/navigation';
import { routing } from '@/i18n/routing';
import { getDatabase } from '@/server/db';
import { requireSession } from '@/server/session';

export const dynamic = 'force-dynamic';

export default async function NotificationsPage() {
  const locale = await rootLocale();
  if (!hasLocale(routing.locales, locale)) notFound();
  const session = await requireSession(locale);
  const { notifications, unreadCount } = await listNotifications(
    getDatabase(),
    { userId: session.user.id },
    { limit: 100 },
  );
  const t = await getTranslations('Notifications');
  return (
    <main className="app-shell mx-auto min-h-dvh w-full max-w-4xl space-y-6 px-5 py-7 sm:px-8">
      <nav aria-label={t('breadcrumb')} className="text-sm">
        <Link href="/dashboard" className="underline underline-offset-4">
          {t('back')}
        </Link>
      </nav>
      <header className="space-y-2">
        <h1 className="text-3xl font-bold">{t('title')}</h1>
        <p className="muted leading-relaxed">{t('description')}</p>
      </header>
      <NotificationsPanel initial={notifications} initialUnread={unreadCount} />
    </main>
  );
}
