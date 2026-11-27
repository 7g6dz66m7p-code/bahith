import { useTranslations } from 'next-intl';

/**
 * The BAHITH emblem drawn in SVG: a pointed academic arch framing a pen nib over an open
 * book (BAHITH's own identity, rebuilt as vector so it stays sharp and themeable).
 */
export function BrandEmblem({ size = 72 }: { size?: number }) {
  return (
    <svg
      viewBox="0 0 96 104"
      width={size}
      height={size * (104 / 96)}
      aria-hidden="true"
      focusable="false"
      className="drop-shadow-[0_0_18px_var(--lg-glow)]"
    >
      <defs>
        <linearGradient id="brand-stroke" x1="0" x2="1" y1="0" y2="1">
          <stop offset="0" stopColor="var(--lg-light)" />
          <stop offset="1" stopColor="var(--lg-ink)" />
        </linearGradient>
      </defs>
      <g fill="none" stroke="url(#brand-stroke)" strokeLinecap="round" strokeLinejoin="round">
        {/* Outer and inner pointed arches */}
        <path strokeWidth="5" d="M14 82V46C14 26 30 12 48 4c18 8 34 22 34 42v36" />
        <path strokeWidth="3.5" d="M25 80V49c0-14 10-25 23-31 13 6 23 17 23 31v31" />
        {/* Pen nib */}
        <path strokeWidth="3.5" d="M48 30l-9 16 9 22 9-22-9-16z" />
        <path strokeWidth="3" d="M48 46v10" />
        <circle cx="48" cy="45" r="2.6" strokeWidth="2.5" />
        {/* Open book */}
        <path strokeWidth="4.5" d="M8 84c14-6 28-6 40 4 12-10 26-10 40-4" />
        <path strokeWidth="3" d="M12 94c12-5 25-5 36 4 11-9 24-9 36-4" />
      </g>
    </svg>
  );
}

/** Emblem + wordmark, as on the sidebar and the hero. */
export function BrandLockup({ compact = false }: { compact?: boolean }) {
  const t = useTranslations('Glass');
  return (
    <div className={`flex items-center gap-3 ${compact ? '' : 'flex-col text-center'}`}>
      <BrandEmblem size={compact ? 44 : 78} />
      <div>
        <p className={`font-bold leading-none ${compact ? 'text-2xl' : 'text-5xl sm:text-6xl'}`}>
          {t('brandName')}
        </p>
        <p
          className="mt-1 text-xs font-semibold tracking-[0.45em] text-[var(--lg-ink)]"
          lang="en"
          dir="ltr"
        >
          {t('brandLatin')}
        </p>
      </div>
    </div>
  );
}
