# ADR-0012: Liquid Glass UI engineering system

- Status: accepted (2026-11-26)
- Scope: `packages/ui`, `apps/web` UI, Storybook, visual/accessibility/performance checks.

## Context

The owner asked for a "Liquid Glass" visual identity (deep-emerald glass, light, waves)
built from a reference image, plus an engineering system to develop and verify it:
Motion, Tailwind, Lucide, Recharts, Storybook, Playwright, axe-core and Lighthouse CI.
`packages/ui` existed but was empty. Constraints: Arabic first (RTL), WCAG 2.2 AA, no
hard-coded text, no fake data, no change to the database, authentication or SANAD-X.

## Decision

1. **Engine in `@bahith/ui`** (React components + `liquid-glass.css`): GlassSurface,
   GlassCard, GlassButton, GlassSearch, GlassSidebar, GlassModal, GlassTooltip,
   AnimatedWaves, AmbientGlow, AdaptiveMotion, ProgressRing, GlassSkeleton,
   GlassThemeProvider. Every visible text is a prop; the app passes its translations.
2. **Tokens as CSS variables.** The six brand colours (`--lg-deep` … `--lg-white`) and
   derived surface/edge/glow/wave tokens per theme. The app's semantic variables
   (`--background`, `--accent`, …) now use this palette, so every page shares it. Text
   and controls use shades that keep AA contrast in both themes; the neon greens are
   for light and glow only.
3. **Effects degrade, never block.** Blur only where `backdrop-filter` is supported and
   transparency is not reduced; `html[data-glass='lite']` (Save-Data, ≤ 2 GB memory or
   ≤ 2 cores) drops blur and ambient motion; `prefers-reduced-motion` stops all motion.
4. **CSS for entrance and page motion, Motion only for interaction.** Entrances are a
   CSS transform (never opacity): server-rendered content is fully visible before any
   script, LCP is not delayed, and contrast is AA on every frame (an opacity entrance
   was tried and failed axe mid-animation). Motion (`LazyMotion` + `domAnimation`)
   animates dialogs and the mobile drawer. Recharts is loaded on demand.
5. **Native `<dialog>` for GlassModal** (focus trap, Escape, inert page, focus return).
6. **Real data only on the dashboard.** Figures are computed by pure functions
   (`apps/web/src/lib/dashboard-overview.ts`, unit-tested) from existing RLS-protected
   services called as the user; stages the platform does not track (final review) and
   features that do not exist (study comparison, plagiarism detection, reports) are
   shown as such, never as progress or as working buttons. No new API route, no schema
   change.
7. **Verification layers.** Storybook (`@storybook/nextjs-vite`, addon-a11y) renders the
   real components with the app's CSS and messages; Playwright compares every visual
   story in ar/en × light/dark against committed baselines and runs axe on each; the
   e2e suite drives the real stack; Lighthouse CI budgets the public pages. All run in
   `.github/workflows/ui-quality.yml` (no secrets).

## Alternatives considered

- A component kit (shadcn/ui, Radix themes): not needed for these primitives; native
  `<dialog>` and plain elements cover the accessibility needs with less code.
- Framer-Motion-driven entrance animations: hide SSR content until hydration (LCP,
  no-JS) — rejected for CSS.
- Visual regression on full app pages: needs the whole stack and is flaky across data;
  stories with fixtures are deterministic. App pages keep functional + axe e2e tests.

## Consequences

- Baseline screenshots must be regenerated (`pnpm --filter @bahith/web test:visual
--update-snapshots`) when a story changes on purpose; differences are uploaded as CI
  artifacts.
- `vite-plugin-storybook-nextjs` declares a TypeScript 5 peer; it works with TS 6 here
  (Storybook builds) — re-check on upgrades.
- Pages other than the dashboard inherit the palette and glass surfaces through the
  shared tokens/classes; their own layouts are not yet redesigned.
