import type messages from '../messages/ar.json';

import type { routing } from './i18n/routing';

// Type-safe message keys and locales for next-intl. Arabic is the source of truth.
declare module 'next-intl' {
  interface AppConfig {
    Locale: (typeof routing.locales)[number];
    Messages: typeof messages;
  }
}
