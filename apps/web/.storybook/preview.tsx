import { GlassThemeProvider } from '@bahith/ui';
import type { Decorator, Preview } from '@storybook/nextjs-vite';
import { NextIntlClientProvider } from 'next-intl';
import { useEffect } from 'react';

import ar from '../messages/ar.json' with { type: 'json' };
import en from '../messages/en.json' with { type: 'json' };

import '../src/app/globals.css';

const messages = { ar, en };

/** Sets lang/dir/data-theme on <html>, as the real layout and theme toggle do. */
function DocumentAttributes({ locale, theme }: { locale: 'ar' | 'en'; theme: 'light' | 'dark' }) {
  useEffect(() => {
    const root = document.documentElement;
    root.lang = locale;
    root.dir = locale === 'ar' ? 'rtl' : 'ltr';
    root.dataset.theme = theme;
  }, [locale, theme]);
  return null;
}

/** Locale (dir/lang) and theme come from the toolbar. */
const withAppShell: Decorator = (Story, context) => {
  const locale = context.globals.locale === 'en' ? 'en' : 'ar';
  const theme = context.globals.theme === 'dark' ? 'dark' : 'light';
  return (
    <NextIntlClientProvider locale={locale} messages={messages[locale]} timeZone="Asia/Baghdad">
      <GlassThemeProvider>
        <DocumentAttributes locale={locale} theme={theme} />
        <div className="p-6 text-foreground">
          <Story />
        </div>
      </GlassThemeProvider>
    </NextIntlClientProvider>
  );
};

const preview: Preview = {
  decorators: [withAppShell],
  globalTypes: {
    locale: {
      description: 'Language and direction',
      toolbar: { icon: 'globe', items: ['ar', 'en'], dynamicTitle: true },
    },
    theme: {
      description: 'Theme',
      toolbar: { icon: 'contrast', items: ['light', 'dark'], dynamicTitle: true },
    },
  },
  initialGlobals: { locale: 'ar', theme: 'light' },
  parameters: {
    nextjs: { appDirectory: true },
    layout: 'fullscreen',
    a11y: { test: 'error' },
  },
};

export default preview;
