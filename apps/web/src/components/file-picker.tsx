'use client';

import { useTranslations } from 'next-intl';
import type { InputHTMLAttributes, RefObject } from 'react';
import { useEffect, useRef, useState } from 'react';

/**
 * A file input with localized text: the browser's own "Choose File / No file chosen"
 * ignores the page language. The real input stays in the page (visually hidden, still
 * focusable and labelled by the caller's <label htmlFor={id}>); focus shows on the button.
 */
export function FilePicker({
  id,
  inputRef,
  ...props
}: Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'className'> & {
  id: string;
  inputRef?: RefObject<HTMLInputElement | null>;
}) {
  const t = useTranslations('FilePicker');
  const wrapper = useRef<HTMLDivElement>(null);
  const [name, setName] = useState<string | null>(null);

  useEffect(() => {
    const form = wrapper.current?.closest('form');
    if (form == null) return;
    const clear = () => {
      setName(null);
    };
    form.addEventListener('reset', clear);
    return () => {
      form.removeEventListener('reset', clear);
    };
  }, []);

  return (
    <div ref={wrapper} className="file-picker flex min-w-0 flex-1 flex-wrap items-center gap-3">
      <input
        {...props}
        id={id}
        ref={inputRef}
        type="file"
        className="sr-only"
        onChange={(event) => {
          setName(event.currentTarget.files?.[0]?.name ?? null);
          props.onChange?.(event);
        }}
      />
      <label htmlFor={id} className="btn-secondary" aria-hidden="true">
        {t('choose')}
      </label>
      <span className="muted min-w-0 break-all text-sm" dir="auto" aria-live="polite">
        {name ?? t('none')}
      </span>
    </div>
  );
}
