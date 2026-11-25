'use client';

import { useTranslations } from 'next-intl';
import { useCallback, useEffect, useId, useRef, useState } from 'react';

import { Link } from '@/i18n/navigation';

export function CommandMenu() {
  const t = useTranslations('CommandMenu');
  const dialog = useRef<HTMLDialogElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const previousFocus = useRef<HTMLElement | null>(null);
  const [query, setQuery] = useState('');
  const id = useId();
  const entries = [
    { href: '/dashboard', label: t('dashboard') },
    { href: '/security', label: t('security') },
    { href: '/', label: t('home') },
  ] as const;
  const visible = entries.filter((entry) =>
    entry.label.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()),
  );

  const open = useCallback(() => {
    if (dialog.current?.open) {
      dialog.current.close();
      return;
    }
    previousFocus.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialog.current?.showModal();
    queueMicrotask(() => input.current?.focus());
  }, []);

  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        open();
      }
    };
    window.addEventListener('keydown', handleKey);
    return () => {
      window.removeEventListener('keydown', handleKey);
    };
  }, [open]);

  return (
    <>
      <button className="btn-secondary inline-flex items-center gap-3" type="button" onClick={open}>
        <span>{t('open')}</span>
        <kbd className="text-xs" dir="ltr">
          {t('shortcut')}
        </kbd>
      </button>
      <dialog
        ref={dialog}
        aria-labelledby={`${id}-title`}
        aria-describedby={`${id}-description`}
        className="surface m-auto w-[min(92vw,32rem)] p-6 text-foreground backdrop:bg-black/50"
        onClick={(event) => {
          if (event.target === event.currentTarget) dialog.current?.close();
        }}
        onClose={() => {
          setQuery('');
          previousFocus.current?.focus();
        }}
      >
        <div className="mb-4 flex items-center justify-between gap-4">
          <h2 className="section-title" id={`${id}-title`}>
            {t('title')}
          </h2>
          <button type="button" className="btn-secondary" onClick={() => dialog.current?.close()}>
            {t('close')}
          </button>
        </div>
        <p id={`${id}-description`} className="muted mb-4 text-sm">
          {t('description')}
        </p>
        <label className="block space-y-2">
          <span>{t('search')}</span>
          <input
            ref={input}
            className="field"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
            }}
          />
        </label>
        <nav aria-label={t('title')} className="mt-4">
          {visible.length === 0 ? (
            <p className="muted py-4">{t('empty')}</p>
          ) : (
            <ul className="space-y-2">
              {visible.map((entry) => (
                <li key={entry.href}>
                  <Link
                    className="block rounded-lg border border-border px-4 py-3 hover:bg-background focus-visible:outline-2 focus-visible:outline-offset-2"
                    href={entry.href}
                    onClick={() => dialog.current?.close()}
                  >
                    {entry.label}
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </nav>
      </dialog>
    </>
  );
}
