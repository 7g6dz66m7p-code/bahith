/**
 * BAHITH Liquid Glass — the design system's engine. Styles live in liquid-glass.css
 * (import "@bahith/ui/liquid-glass.css" once); components take every visible text as a
 * prop so the application keeps all wording in its translation files.
 */
export { AdaptiveMotion, AmbientGlow, AnimatedWaves, GlassSkeleton, ProgressRing } from './ambient';
export {
  GlassButton,
  glassButtonProps,
  GlassSearch,
  GlassTooltip,
  type GlassButtonProps,
  type GlassButtonSize,
  type GlassButtonVariant,
  type GlassSearchProps,
} from './glass-controls';
export { GlassModal, type GlassModalProps } from './glass-modal';
export { GlassSidebar, type GlassNavItem, type GlassSidebarProps } from './glass-sidebar';
export {
  GlassCard,
  GlassSurface,
  type GlassCardProps,
  type GlassSurfaceProps,
} from './glass-surface';
export { detectGlassMode, GlassThemeProvider, useGlassMode, type GlassMode } from './glass-theme';
