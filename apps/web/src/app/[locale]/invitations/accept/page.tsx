import { hasLocale } from 'next-intl';
import { getTranslations } from 'next-intl/server';
import { notFound } from 'next/navigation';
import { locale as rootLocale } from 'next/root-params';

import { AcceptInvitation } from '@/components/accept-invitation';
import { routing } from '@/i18n/routing';
import { requireSession } from '@/server/session';

export const dynamic = 'force-dynamic';

export default async function AcceptInvitationPage() {
  const locale = await rootLocale();
  if (!hasLocale(routing.locales, locale)) notFound();
  await requireSession(locale);
  const t = await getTranslations('Invitation');
  return (
    <main className="app-shell mx-auto min-h-dvh w-full max-w-xl space-y-6 px-5 py-10 sm:px-8">
      <section className="surface space-y-4 p-6 sm:p-8">
        <h1 className="text-2xl font-bold">{t('title')}</h1>
        <p className="muted leading-relaxed">{t('description')}</p>
        <AcceptInvitation />
      </section>
    </main>
  );
}
