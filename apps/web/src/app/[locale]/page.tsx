import { getTranslations } from 'next-intl/server';

import { LocaleSwitcher } from '@/components/locale-switcher';

export default async function HomePage() {
  const t = await getTranslations('Home');

  return (
    <main className="mx-auto flex min-h-dvh max-w-2xl flex-col justify-center gap-6 px-6 py-16">
      <LocaleSwitcher />
      <h1 className="text-4xl font-bold">{t('name')}</h1>
      <p className="text-lg text-neutral-700">{t('tagline')}</p>
      <section
        aria-labelledby="principle-title"
        className="border-s-4 border-neutral-900 ps-4 text-start"
      >
        <h2 id="principle-title" className="font-semibold">
          {t('principleTitle')}
        </h2>
        <p className="mt-2 text-neutral-700">{t('principle')}</p>
      </section>
      <p className="text-sm text-neutral-600">{t('status')}</p>
    </main>
  );
}
