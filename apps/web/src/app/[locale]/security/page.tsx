import { hasLocale } from 'next-intl';
import { notFound } from 'next/navigation';
import { locale as rootLocale } from 'next/root-params';

import { AccountSecurity } from '@/components/account-security';
import { CommandMenu } from '@/components/command-menu';
import { LocaleSwitcher } from '@/components/locale-switcher';
import { routing } from '@/i18n/routing';
import { requireSession } from '@/server/session';

export default async function SecurityPage() {
  const locale = await rootLocale();
  if (!hasLocale(routing.locales, locale)) notFound();
  const session = await requireSession(locale);
  return (
    <main className="app-shell mx-auto min-h-dvh w-full max-w-3xl space-y-6 px-5 py-8 sm:px-8">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <CommandMenu />
        <LocaleSwitcher />
      </div>
      <AccountSecurity twoFactorEnabled={Boolean(session.user.twoFactorEnabled)} />
    </main>
  );
}
