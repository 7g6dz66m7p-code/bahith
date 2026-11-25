import { useLocale, useTranslations } from 'next-intl';

import { Link } from '@/i18n/navigation';
import { routing } from '@/i18n/routing';

/** Links to the same page in each supported language. */
export function LocaleSwitcher() {
  const t = useTranslations('LocaleSwitcher');
  const current = useLocale();

  return (
    <nav aria-label={t('label')} className="flex gap-4 text-sm">
      {routing.locales.map((locale) => (
        <Link
          key={locale}
          href="/"
          locale={locale}
          lang={locale}
          aria-current={locale === current ? 'true' : undefined}
          className="underline-offset-4 hover:underline aria-[current=true]:font-semibold"
        >
          {t(locale)}
        </Link>
      ))}
    </nav>
  );
}
