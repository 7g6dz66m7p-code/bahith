import { getTranslations } from 'next-intl/server';

import { Link } from '@/i18n/navigation';

export default async function NotFound() {
  const t = await getTranslations('NotFound');

  return (
    <main className="mx-auto flex min-h-dvh max-w-2xl flex-col justify-center gap-4 px-6 py-16">
      <h1 className="text-2xl font-bold">{t('title')}</h1>
      <Link href="/" className="underline">
        {t('backHome')}
      </Link>
    </main>
  );
}
