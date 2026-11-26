'use client';

import type { ReactNode } from 'react';

const WAVE_WIDTH = 1440;

/** Twice the view width (period 720), so translating by -50% loops seamlessly. */
function wavePath(amplitude: number, base: number, phase: number): string {
  const step = WAVE_WIDTH / 4;
  let d = `M0 ${String(base)}`;
  for (let i = 0; i < 8; i += 1) {
    const x1 = i * step + step / 2;
    const y1 = base + ((i + phase) % 2 === 0 ? -amplitude : amplitude);
    d += ` Q${String(x1)} ${String(y1)} ${String((i + 1) * step)} ${String(base)}`;
  }
  return `${d} V320 H0 Z`;
}

/** Three translucent green wave layers drifting at different speeds (CSS animation). */
export function AnimatedWaves({ className = '' }: { className?: string }) {
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      className={`lg-waves ${className}`}
      viewBox={`0 0 ${String(WAVE_WIDTH)} 320`}
      preserveAspectRatio="none"
    >
      <path className="lg-wave" data-layer="3" d={wavePath(26, 150, 0)} />
      <path className="lg-wave" data-layer="2" d={wavePath(34, 190, 1)} />
      <path className="lg-wave" data-layer="1" d={wavePath(22, 235, 0)} />
    </svg>
  );
}

// A fixed constellation (no randomness: identical on server and client, stable screenshots).
const NODES: [number, number][] = [
  [120, 80],
  [260, 40],
  [380, 120],
  [520, 60],
  [640, 150],
  [760, 70],
  [900, 130],
  [1040, 50],
  [1180, 110],
  [1320, 60],
  [200, 190],
  [460, 210],
  [700, 230],
  [980, 210],
  [1240, 200],
];
const EDGES: [number, number][] = [
  [0, 1],
  [1, 2],
  [2, 3],
  [3, 4],
  [4, 5],
  [5, 6],
  [6, 7],
  [7, 8],
  [8, 9],
  [0, 10],
  [10, 2],
  [2, 11],
  [11, 4],
  [4, 12],
  [12, 6],
  [6, 13],
  [13, 8],
  [8, 14],
  [14, 9],
  [3, 5],
  [1, 3],
];

/**
 * The page's light: soft emerald glows, a neural-network constellation and the waves.
 * Purely decorative (aria-hidden), behind all content, no pointer events.
 */
export function AmbientGlow({ waves = true }: { waves?: boolean }) {
  return (
    <div className="lg-ambient" aria-hidden="true">
      <div
        className="lg-orb"
        style={{ width: '34rem', height: '34rem', insetInlineEnd: '-8rem', top: '-10rem' }}
      />
      <div
        className="lg-orb"
        style={{
          width: '26rem',
          height: '26rem',
          insetInlineStart: '-6rem',
          bottom: '-6rem',
          animationDelay: '-6s',
        }}
      />
      <svg
        className="lg-network absolute inset-x-0 top-0 h-64 w-full"
        viewBox="0 0 1440 260"
        preserveAspectRatio="xMidYMin slice"
      >
        {EDGES.map(([a, b]) => {
          const [x1, y1] = NODES[a] ?? [0, 0];
          const [x2, y2] = NODES[b] ?? [0, 0];
          return <line key={`${String(a)}-${String(b)}`} x1={x1} y1={y1} x2={x2} y2={y2} />;
        })}
        {NODES.map(([cx, cy], index) => (
          <circle
            key={`${String(cx)}-${String(cy)}`}
            cx={cx}
            cy={cy}
            r={2.6}
            style={{ animationDelay: `${String(-index * 0.4)}s` }}
          />
        ))}
      </svg>
      {waves ? <AnimatedWaves /> : null}
    </div>
  );
}

/**
 * Entrance motion that adapts: a short rise in CSS (movement only, never opacity, so
 * server-rendered content is fully visible before any script runs); no motion when
 * the user prefers reduced motion or the device runs in lite glass mode.
 */
export function AdaptiveMotion({
  children,
  delay = 0,
  className = '',
}: {
  children: ReactNode;
  delay?: number;
  className?: string;
}) {
  return (
    <div className={`lg-rise ${className}`.trim()} style={{ animationDelay: `${String(delay)}s` }}>
      {children}
    </div>
  );
}

/** A circular progress indicator with its value spoken as text. */
export function ProgressRing({
  value,
  label,
  size = 148,
}: {
  value: number;
  label: string;
  size?: number;
}) {
  const clamped = Math.max(0, Math.min(100, Math.round(value)));
  const radius = 42;
  const circumference = 2 * Math.PI * radius;
  return (
    <div className="relative inline-grid place-items-center" style={{ width: size, height: size }}>
      <svg viewBox="0 0 100 100" className="absolute inset-0 -rotate-90" aria-hidden="true">
        <circle cx="50" cy="50" r={radius} fill="none" stroke="var(--lg-track)" strokeWidth="9" />
        <circle
          cx="50"
          cy="50"
          r={radius}
          fill="none"
          stroke="url(#lg-ring)"
          strokeWidth="9"
          strokeLinecap="round"
          strokeDasharray={`${String((clamped / 100) * circumference)} ${String(circumference)}`}
        />
        <defs>
          <linearGradient id="lg-ring" x1="0" x2="1" y1="0" y2="1">
            <stop offset="0" stopColor="var(--lg-light)" />
            <stop offset="1" stopColor="var(--lg-primary)" />
          </linearGradient>
        </defs>
      </svg>
      <span role="img" aria-label={label} className="text-3xl font-bold tabular-nums">
        {`${String(clamped)}%`}
      </span>
    </div>
  );
}

/** Placeholder shapes while data loads. */
export function GlassSkeleton({ lines = 3 }: { lines?: number }) {
  return (
    <div className="space-y-3" aria-hidden="true">
      {Array.from({ length: lines }, (_, index) => (
        <div
          key={index}
          className="lg-skeleton h-4"
          style={{ width: `${String(100 - index * 12)}%` }}
        />
      ))}
    </div>
  );
}
