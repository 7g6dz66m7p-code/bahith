import { getTranslations } from 'next-intl/server';

import { LocaleSwitcher } from '@/components/locale-switcher';
import { Link } from '@/i18n/navigation';

export default async function HomePage() {
  const t = await getTranslations('Home');

  return (
    <main className="app-shell min-h-dvh px-5 py-8 sm:px-10">
      <header className="flex flex-wrap items-center justify-between gap-4 border-b border-border pb-6">
        <span className="text-2xl font-semibold">{t('name')}</span>
        <div className="flex flex-wrap items-center gap-5">
          <LocaleSwitcher />
          <Link href="/sign-in" className="btn-secondary">
            {t('enter')}
          </Link>
        </div>
      </header>
      <section className="grid items-center gap-12 py-16 lg:grid-cols-2 lg:py-24">
        <div className="space-y-7">
          <h1 className="text-6xl font-semibold tracking-tight sm:text-8xl">{t('name')}</h1>
          <p className="max-w-xl text-xl leading-loose muted">{t('tagline')}</p>
          <div className="flex flex-wrap gap-4">
            <Link href="/sign-up" className="btn">
              {t('createAccount')}
            </Link>
            <Link href="/sign-in" className="btn-secondary">
              {t('enter')}
            </Link>
          </div>
        </div>
        <section className="surface p-8 sm:p-10" aria-labelledby="workflow-title">
          <h2 id="workflow-title" className="section-title mb-7">
            {t('workflowTitle')}
          </h2>
          <ol className="space-y-6 border-s-2 border-border ps-6 font-serif text-2xl leading-relaxed">
            {(['questionStep', 'sourceStep', 'evidenceStep', 'reviewStep'] as const).map((step) => (
              <li key={step}>{t(step)}</li>
            ))}
          </ol>
        </section>
      </section>
      <section
        aria-labelledby="principle-title"
        className="border-s-4 border-accent ps-6 text-start"
      >
        <h2 id="principle-title" className="font-semibold">
          {t('principleTitle')}
        </h2>
        <p className="mt-3 max-w-4xl font-serif text-xl leading-loose muted">{t('principle')}</p>
      </section>
      <section className="space-y-6 py-14" aria-labelledby="features-title">
        <h2 id="features-title" className="section-title">
          {t('featuresTitle')}
        </h2>
        <div className="grid gap-5 md:grid-cols-3">
          {(['trace', 'privacy', 'review'] as const).map((feature) => (
            <article className="surface space-y-3 p-6" key={feature}>
              <h3 className="text-xl font-semibold">{t(`${feature}Title`)}</h3>
              <p className="muted leading-relaxed">{t(`${feature}Description`)}</p>
            </article>
          ))}
        </div>
      </section>
      <footer className="border-t border-border py-6">
        <p className="muted text-sm">{t('status')}</p>
      </footer>
    </main>
  );
}
