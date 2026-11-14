import { hasLocale } from 'next-intl';
import { notFound } from 'next/navigation';
import { locale as rootLocale } from 'next/root-params';

import { DashboardView } from '@/components/dashboard-view';
import { routing } from '@/i18n/routing';
import { getDashboardData } from '@/server/dashboard';
import { requireSession } from '@/server/session';

export default async function DashboardPage() {
  const locale = await rootLocale();
  if (!hasLocale(routing.locales, locale)) notFound();
  const session = await requireSession(locale);
  const data = await getDashboardData(session.user.id);
  return (
    <DashboardView name={session.user.name} workspaces={data.workspaces} projects={data.projects} />
  );
}
