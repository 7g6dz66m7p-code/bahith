'use client';

import { domAnimation, LazyMotion, MotionConfig } from 'motion/react';
import { createContext, use, useEffect, useState } from 'react';
import type { ReactNode } from 'react';

/** "full": blur, sheen and motion. "lite": solid glass, no ambient animation. */
export type GlassMode = 'full' | 'lite';

interface GlassContextValue {
  mode: GlassMode;
  setMode: (mode: GlassMode) => void;
}

const GlassContext = createContext<GlassContextValue>({ mode: 'full', setMode: () => undefined });

interface DeviceHints {
  connection?: { saveData?: boolean };
  deviceMemory?: number;
  hardwareConcurrency?: number;
}

/** Expensive effects are dropped on Save-Data and on very low-power devices. */
export function detectGlassMode(device: DeviceHints): GlassMode {
  if (device.connection?.saveData === true) return 'lite';
  if ((device.deviceMemory ?? 8) <= 2) return 'lite';
  if ((device.hardwareConcurrency ?? 8) <= 2) return 'lite';
  return 'full';
}

/**
 * Root of the Liquid Glass engine: picks the effect level for the device, exposes it on
 * <html data-glass>, loads only the Motion features the engine uses (LazyMotion), and
 * makes every Motion animation follow the user's reduced-motion preference.
 */
export function GlassThemeProvider({
  children,
  mode: forcedMode,
}: {
  children: ReactNode;
  mode?: GlassMode;
}) {
  const [mode, setMode] = useState<GlassMode>(forcedMode ?? 'full');
  useEffect(() => {
    if (forcedMode !== undefined) {
      setMode(forcedMode);
      return;
    }
    setMode(detectGlassMode(navigator));
  }, [forcedMode]);
  useEffect(() => {
    document.documentElement.dataset.glass = mode;
  }, [mode]);
  return (
    <GlassContext value={{ mode, setMode }}>
      <LazyMotion features={domAnimation} strict>
        <MotionConfig reducedMotion="user">{children}</MotionConfig>
      </LazyMotion>
    </GlassContext>
  );
}

export function useGlassMode(): GlassContextValue {
  return use(GlassContext);
}
