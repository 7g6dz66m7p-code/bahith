import { getPlatformStats, listPlans } from '@bahith/db';
import { hasLocale } from 'next-intl';
import { getTranslations } from 'next-intl/server';
import { headers } from 'next/headers';
import { notFound } from 'next/navigation';
import { locale as rootLocale } from 'next/root-params';

import { AdminPanel } from '@/components/admin-panel';
import { routing } from '@/i18n/routing';
import { getDatabase } from '@/server/db';
import { isPlatformAdmin } from '@/server/platform-admin';
import { getRequestSession, requireSession } from '@/server/session';

export const dynamic = 'force-dynamic';

export default async function AdminPage() {
  const locale = await rootLocale();
  if (!hasLocale(routing.locales, locale)) notFound();
  await requireSession(locale);
  const session = await getRequestSession(
    new Request('http://localhost/', { headers: await headers() }),
  );
  // Not an administrator: the page does not exist for them.
  if (!isPlatformAdmin(session)) notFound();
  const database = getDatabase();
  const [stats, plans] = await Promise.all([getPlatformStats(database), listPlans(database)]);
  const t = await getTranslations('Admin');
  return (
    <main className="app-shell mx-auto min-h-dvh w-full max-w-6xl space-y-6 px-5 py-7 sm:px-8">
      <header className="space-y-2">
        <h1 className="text-3xl font-bold">{t('title')}</h1>
        <p className="muted">{t('description')}</p>
      </header>
      <AdminPanel stats={stats} plans={plans} />
    </main>
  );
}
