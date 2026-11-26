'use client';

import { useState } from 'react';
import type { ReactNode } from 'react';

import { glassButtonProps } from './glass-controls';
import { GlassModal } from './glass-modal';
import { GlassSurface } from './glass-surface';

export interface GlassNavItem {
  key: string;
  label: string;
  icon: ReactNode;
  /** Present when the destination exists; items without it are shown as unavailable. */
  href?: string;
  current?: boolean;
  /** Why an item is unavailable (read to assistive tech and shown as a badge). */
  unavailableLabel?: string;
}

export interface GlassSidebarProps {
  label: string;
  brand: ReactNode;
  items: GlassNavItem[];
  footer?: ReactNode;
  openMenuLabel: string;
  closeMenuLabel: string;
  /** Renders a link (e.g. Next.js <Link> with locale-aware routing). */
  renderLink: (
    item: GlassNavItem & { href: string },
    className: string,
    children: ReactNode,
  ) => ReactNode;
}

function NavList({
  items,
  renderLink,
  onNavigate,
}: Pick<GlassSidebarProps, 'items' | 'renderLink'> & { onNavigate?: () => void }) {
  return (
    <ul className="space-y-1.5" onClick={onNavigate}>
      {items.map((item) => {
        const body = (
          <>
            <span aria-hidden="true" className="shrink-0">
              {item.icon}
            </span>
            <span className="min-w-0 flex-1 truncate">{item.label}</span>
            {item.unavailableLabel === undefined ? null : (
              <span className="lg-badge">{item.unavailableLabel}</span>
            )}
          </>
        );
        const className =
          'lg-nav-item lg-interactive flex items-center gap-3 rounded-full border border-transparent px-4 py-2.5';
        return (
          <li key={item.key}>
            {item.href === undefined ? (
              <span className={className} aria-disabled="true">
                {body}
              </span>
            ) : (
              renderLink({ ...item, href: item.href }, className, body)
            )}
          </li>
        );
      })}
    </ul>
  );
}

/**
 * The glass navigation: a sticky column on wide screens, a menu button opening a modal
 * drawer on phones and tablets (same links, focus trapped, Escape closes).
 */
export function GlassSidebar({
  label,
  brand,
  items,
  footer,
  openMenuLabel,
  closeMenuLabel,
  renderLink,
}: GlassSidebarProps) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <div className="lg:hidden">
        <button
          type="button"
          aria-haspopup="dialog"
          aria-expanded={open}
          onClick={() => {
            setOpen(true);
          }}
          {...glassButtonProps('glass', 'md')}
        >
          <span aria-hidden="true">☰</span>
          {openMenuLabel}
        </button>
        <GlassModal
          open={open}
          onClose={() => {
            setOpen(false);
          }}
          title={label}
          closeLabel={closeMenuLabel}
          placement="side"
        >
          <nav aria-label={label}>
            <NavList
              items={items}
              renderLink={renderLink}
              onNavigate={() => {
                setOpen(false);
              }}
            />
          </nav>
          {footer === undefined ? null : <div className="mt-5">{footer}</div>}
        </GlassModal>
      </div>
      <GlassSurface
        as="aside"
        sheen
        className="sticky top-4 hidden max-h-[calc(100dvh-2rem)] w-64 shrink-0 flex-col gap-6 overflow-y-auto p-4 lg:flex"
      >
        <div className="px-2 pt-2">{brand}</div>
        <nav aria-label={label}>
          <NavList items={items} renderLink={renderLink} />
        </nav>
        {footer === undefined ? null : <div className="mt-auto">{footer}</div>}
      </GlassSurface>
    </>
  );
}
