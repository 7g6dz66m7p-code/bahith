import type { Metadata } from 'next';
import { hasLocale, NextIntlClientProvider } from 'next-intl';
import { getTranslations } from 'next-intl/server';
import { notFound } from 'next/navigation';
import { locale as rootLocale } from 'next/root-params';
import type { ReactNode } from 'react';

import { localeDirection, routing } from '@/i18n/routing';

import '../globals.css';

export function generateStaticParams() {
  return routing.locales.map((locale) => ({ locale }));
}

export async function generateMetadata(): Promise<Metadata> {
  if (!hasLocale(routing.locales, await rootLocale())) {
    return {};
  }
  const t = await getTranslations('Metadata');
  return { title: t('title'), description: t('description') };
}

export default async function LocaleLayout({ children }: { children: ReactNode }) {
  const locale = await rootLocale();
  if (!hasLocale(routing.locales, locale)) {
    notFound();
  }

  return (
    <html lang={locale} dir={localeDirection(locale)}>
      <body className="min-h-dvh bg-white text-neutral-900 antialiased">
        <NextIntlClientProvider>{children}</NextIntlClientProvider>
      </body>
    </html>
  );
}
