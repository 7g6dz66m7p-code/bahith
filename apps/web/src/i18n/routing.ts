import { defineRouting } from 'next-intl/routing';

export const locales = ['ar', 'en'] as const;
export type Locale = (typeof locales)[number];

/** Arabic first: Arabic is the default locale and the fallback. */
export const routing = defineRouting({
  locales,
  defaultLocale: 'ar',
  localePrefix: 'always',
});

/** Writing direction of a locale, for the `dir` attribute of <html>. */
export function localeDirection(locale: Locale): 'rtl' | 'ltr' {
  return locale === 'ar' ? 'rtl' : 'ltr';
}
