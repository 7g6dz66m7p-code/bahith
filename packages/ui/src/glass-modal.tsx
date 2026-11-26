'use client';

import { AnimatePresence, m } from 'motion/react';
import { useEffect, useId, useRef } from 'react';
import type { ReactNode } from 'react';

export interface GlassModalProps {
  open: boolean;
  onClose: () => void;
  title: string;
  closeLabel: string;
  /** "side" slides in from the inline-start edge (the mobile navigation drawer). */
  placement?: 'center' | 'side';
  children: ReactNode;
}

/**
 * A native modal <dialog>: the browser traps focus, makes the page inert and closes on
 * Escape; focus returns to the opener. Motion only animates the panel inside.
 */
export function GlassModal({
  open,
  onClose,
  title,
  closeLabel,
  placement = 'center',
  children,
}: GlassModalProps) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const element = dialog.current;
    if (element === null) return;
    if (open && !element.open) element.showModal();
    if (!open && element.open) element.close();
  }, [open]);
  const side = placement === 'side';
  return (
    <dialog
      ref={dialog}
      aria-labelledby={titleId}
      className={`lg-dialog ${side ? 'lg-dialog-side' : ''}`}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <AnimatePresence>
        {open ? (
          <m.div
            key="panel"
            className={`lg-glass p-5 ${side ? 'h-full w-[min(20rem,86vw)] overflow-y-auto' : 'w-[min(32rem,92vw)]'}`}
            data-elevation="raised"
            initial={side ? { opacity: 0, x: 24 } : { opacity: 0, y: 12, scale: 0.98 }}
            animate={side ? { opacity: 1, x: 0 } : { opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.26, ease: [0.22, 1, 0.36, 1] }}
          >
            <div className="mb-4 flex items-center justify-between gap-3">
              <h2 id={titleId} className="text-lg font-bold">
                {title}
              </h2>
              <button
                type="button"
                className="lg-button lg-interactive"
                data-variant="glass"
                data-size="icon"
                onClick={onClose}
              >
                <span aria-hidden="true">×</span>
                <span className="sr-only">{closeLabel}</span>
              </button>
            </div>
            {children}
          </m.div>
        ) : null}
      </AnimatePresence>
    </dialog>
  );
}
