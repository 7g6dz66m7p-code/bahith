'use client';

import { useTranslations } from 'next-intl';
import { useEffect, useSyncExternalStore } from 'react';

const THEMES = ['system', 'light', 'dark'] as const;
type Theme = (typeof THEMES)[number];
const KEY = 'bahith-theme';
function snapshot(): Theme {
  try {
    const stored = localStorage.getItem(KEY);
    return stored === 'dark' || stored === 'light' ? stored : 'system';
  } catch {
    return 'system';
  }
}
function subscribe(listener: () => void) {
  window.addEventListener('storage', listener);
  window.addEventListener('bahith-theme', listener);
  return () => {
    window.removeEventListener('storage', listener);
    window.removeEventListener('bahith-theme', listener);
  };
}
export function ThemeToggle() {
  const t = useTranslations('Theme');
  const theme = useSyncExternalStore<Theme>(subscribe, snapshot, () => 'system');
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);
  return (
    <button
      type="button"
      className="btn-secondary text-sm"
      aria-label={`${t('label')}: ${t(theme)}`}
      onClick={() => {
        const next = THEMES[(THEMES.indexOf(theme) + 1) % THEMES.length] ?? 'system';
        try {
          localStorage.setItem(KEY, next);
        } catch {
          /* System preference remains available. */
        }
        window.dispatchEvent(new Event('bahith-theme'));
      }}
    >
      {t(theme)}
    </button>
  );
}
