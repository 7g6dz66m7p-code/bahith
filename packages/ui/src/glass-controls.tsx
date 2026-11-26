'use client';

import { cloneElement, useId, useState } from 'react';
import type {
  ButtonHTMLAttributes,
  FocusEvent,
  KeyboardEvent,
  ReactElement,
  ReactNode,
  SubmitEvent,
} from 'react';

export type GlassButtonVariant = 'primary' | 'glass';
export type GlassButtonSize = 'md' | 'icon';

/** The attributes that style any element (a link included) as a glass button. */
export function glassButtonProps(
  variant: GlassButtonVariant = 'glass',
  size: GlassButtonSize = 'md',
  className = '',
) {
  return {
    className: `lg-button lg-interactive ${className}`.trim(),
    'data-variant': variant,
    'data-size': size,
  } as const;
}

export interface GlassButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: GlassButtonVariant;
  size?: GlassButtonSize;
}

export function GlassButton({
  variant = 'glass',
  size = 'md',
  className = '',
  type = 'button',
  children,
  ...rest
}: GlassButtonProps) {
  return (
    <button {...rest} type={type} {...glassButtonProps(variant, size, className)}>
      {children}
    </button>
  );
}

export interface GlassSearchProps {
  /** Accessible name of the field (also the visually hidden label). */
  label: string;
  placeholder: string;
  submitLabel: string;
  busy?: boolean;
  disabled?: boolean;
  /** Called with the trimmed query; empty queries are not submitted. */
  onSearch: (query: string) => void;
  /** Extra controls inside the bar (e.g. a scope selector). */
  children?: ReactNode;
  icon?: ReactNode;
  id?: string;
}

/** The pill-shaped search bar; a real form, so Enter and assistive tech work as usual. */
export function GlassSearch({
  label,
  placeholder,
  submitLabel,
  busy = false,
  disabled = false,
  onSearch,
  children,
  icon,
  id,
}: GlassSearchProps) {
  const fallbackId = useId();
  const inputId = id ?? fallbackId;
  const submit = (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    const value = new FormData(event.currentTarget).get('q');
    const query = typeof value === 'string' ? value.trim() : '';
    if (query !== '') onSearch(query);
  };
  return (
    <form role="search" className="lg-glass lg-search" onSubmit={submit} aria-busy={busy}>
      <label htmlFor={inputId} className="sr-only">
        {label}
      </label>
      <input
        id={inputId}
        name="q"
        type="search"
        dir="auto"
        placeholder={placeholder}
        disabled={disabled}
        required
        minLength={2}
        maxLength={500}
        autoComplete="off"
      />
      {children}
      <button
        type="submit"
        disabled={disabled || busy}
        {...glassButtonProps('primary', 'md', 'min-w-[3.25rem]')}
      >
        {icon}
        <span className={icon === undefined ? undefined : 'sr-only sm:not-sr-only'}>
          {submitLabel}
        </span>
      </button>
    </form>
  );
}

/**
 * Tooltip on hover and keyboard focus (WCAG 1.4.13: dismissible with Escape, stays while
 * hovered). The trigger keeps its own accessible name; the tooltip is a description.
 */
export function GlassTooltip({
  label,
  children,
}: {
  label: string;
  children: ReactElement<{
    'aria-describedby'?: string;
    onKeyDown?: (event: KeyboardEvent<HTMLElement>) => void;
  }>;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  return (
    <span
      className="relative inline-flex"
      onPointerEnter={() => {
        setOpen(true);
      }}
      onPointerLeave={() => {
        setOpen(false);
      }}
      onFocus={() => {
        setOpen(true);
      }}
      onBlur={(event: FocusEvent<HTMLSpanElement>) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
      }}
      onKeyDown={(event: KeyboardEvent<HTMLSpanElement>) => {
        if (event.key === 'Escape') setOpen(false);
      }}
    >
      {cloneElement(children, { 'aria-describedby': id })}
      <span
        id={id}
        role="tooltip"
        className="lg-glass lg-tooltip"
        data-elevation="raised"
        hidden={!open}
      >
        {label}
      </span>
    </span>
  );
}
