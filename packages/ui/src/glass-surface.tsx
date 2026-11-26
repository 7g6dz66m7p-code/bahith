'use client';

import { useRef } from 'react';
import type { HTMLAttributes, PointerEvent, ReactNode } from 'react';

type SurfaceTag = 'div' | 'section' | 'aside' | 'article' | 'nav' | 'header' | 'li' | 'form';

export interface GlassSurfaceProps extends HTMLAttributes<HTMLElement> {
  as?: SurfaceTag;
  /** "raised" is more opaque, for content that sits on other glass. */
  elevation?: 'base' | 'raised';
  /** A slow light sweep across the surface (full glass mode, motion allowed). */
  sheen?: boolean;
  /** The specular light follows the pointer. */
  interactive?: boolean;
  children?: ReactNode;
}

const cx = (...parts: (string | false | undefined)[]) => parts.filter(Boolean).join(' ');

/** The base material: translucent, blurred where supported, solid where it must be. */
export function GlassSurface({
  as: Tag = 'div',
  elevation = 'base',
  sheen = false,
  interactive = false,
  className,
  onPointerMove,
  children,
  ...rest
}: GlassSurfaceProps) {
  const frame = useRef<number | null>(null);
  const follow = (event: PointerEvent<HTMLElement>) => {
    onPointerMove?.(event);
    if (!interactive || event.pointerType === 'touch') return;
    const target = event.currentTarget;
    const { clientX, clientY } = event;
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(() => {
      const box = target.getBoundingClientRect();
      target.style.setProperty('--lg-x', `${String(((clientX - box.left) / box.width) * 100)}%`);
      target.style.setProperty('--lg-y', `${String(((clientY - box.top) / box.height) * 100)}%`);
    });
  };
  return (
    <Tag
      {...rest}
      className={cx('lg-glass', className)}
      data-elevation={elevation}
      data-sheen={sheen ? 'true' : undefined}
      data-interactive={interactive ? 'true' : undefined}
      onPointerMove={follow}
    >
      {children}
    </Tag>
  );
}

export interface GlassCardProps extends Omit<GlassSurfaceProps, 'title'> {
  title?: ReactNode;
  icon?: ReactNode;
  /** Shown at the end of the header (a link, a count…). */
  action?: ReactNode;
  headingLevel?: 2 | 3;
  headingId?: string;
}

/** A titled glass panel; the heading labels the region when an id is given. */
export function GlassCard({
  title,
  icon,
  action,
  headingLevel = 2,
  headingId,
  className,
  children,
  as = 'section',
  interactive = true,
  ...rest
}: GlassCardProps) {
  const Heading = headingLevel === 2 ? 'h2' : 'h3';
  return (
    <GlassSurface
      {...rest}
      as={as}
      interactive={interactive}
      className={cx('p-5', className)}
      aria-labelledby={title === undefined ? rest['aria-labelledby'] : headingId}
    >
      {title === undefined ? null : (
        <div className="mb-4 flex items-center justify-between gap-3">
          <Heading id={headingId} className="flex items-center gap-2 text-lg font-bold">
            {icon === undefined ? null : (
              <span aria-hidden="true" className="lg-icon">
                {icon}
              </span>
            )}
            {title}
          </Heading>
          {action}
        </div>
      )}
      {children}
    </GlassSurface>
  );
}
