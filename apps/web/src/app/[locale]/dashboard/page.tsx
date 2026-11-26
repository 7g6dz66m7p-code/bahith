import { hasLocale } from 'next-intl';
import { notFound } from 'next/navigation';
import { locale as rootLocale } from 'next/root-params';

import { DashboardView } from '@/components/dashboard-view';
import { routing } from '@/i18n/routing';
import { getDashboardData, getDashboardExtras } from '@/server/dashboard';
import { getUnreadNotificationCount } from '@/server/notifications';
import { requireSession } from '@/server/session';

export default async function DashboardPage() {
  const locale = await rootLocale();
  if (!hasLocale(routing.locales, locale)) notFound();
  const session = await requireSession(locale);
  const [data, unread] = await Promise.all([
    getDashboardData(session.user.id),
    getUnreadNotificationCount(session.user.id),
  ]);
  const extras = await getDashboardExtras(session.user.id, data);
  return (
    <DashboardView
      name={session.user.name}
      workspaces={data.workspaces}
      projects={data.projects}
      unreadNotifications={unread}
      extras={extras}
    />
  );
}
