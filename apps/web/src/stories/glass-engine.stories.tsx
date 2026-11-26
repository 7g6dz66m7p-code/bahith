import {
  AnimatedWaves,
  GlassButton,
  GlassCard,
  GlassModal,
  GlassSearch,
  GlassSkeleton,
  GlassSurface,
  GlassTooltip,
  ProgressRing,
} from '@bahith/ui';
import type { Meta, StoryObj } from '@storybook/nextjs-vite';
import { Search, Sparkles } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useState } from 'react';

/** The Liquid Glass engine's primitives, with the app's real wording. */
const meta: Meta = { title: 'Liquid Glass/Engine', tags: ['visual'] };
export default meta;

export const Surfaces: StoryObj = {
  render: function Render() {
    const t = useTranslations('Glass');
    return (
      <div className="grid max-w-4xl gap-5 sm:grid-cols-2">
        <GlassCard
          title={t('assistant.title')}
          headingId="s-card"
          icon={<Sparkles className="size-5" />}
          sheen
        >
          <p className="muted text-sm leading-relaxed">{t('assistant.description')}</p>
        </GlassCard>
        <GlassSurface elevation="raised" interactive className="p-5">
          <p className="font-bold">{t('tagline')}</p>
          <p className="muted text-sm">{t('search.note')}</p>
        </GlassSurface>
      </div>
    );
  },
};

export const Buttons: StoryObj = {
  render: function Render() {
    const t = useTranslations('Glass');
    return (
      <div className="flex flex-wrap items-center gap-3">
        <GlassButton variant="primary">{t('assistant.start')}</GlassButton>
        <GlassButton>{t('activity.all')}</GlassButton>
        <GlassButton disabled>{t('tools.unavailable')}</GlassButton>
        <GlassTooltip label={t('search.note')}>
          <GlassButton size="icon" aria-label={t('search.submit')}>
            <Search aria-hidden="true" className="size-5" />
          </GlassButton>
        </GlassTooltip>
      </div>
    );
  },
};

export const SearchBar: StoryObj = {
  render: function Render() {
    const t = useTranslations('Glass.search');
    return (
      <div className="max-w-3xl">
        <GlassSearch
          label={t('label')}
          placeholder={t('placeholder')}
          submitLabel={t('submit')}
          icon={<Search aria-hidden="true" className="size-5" />}
          onSearch={() => undefined}
        />
      </div>
    );
  },
};

export const ProgressAndLoading: StoryObj = {
  render: function Render() {
    const t = useTranslations('Glass.workflow');
    return (
      <div className="flex flex-wrap items-center gap-8">
        <ProgressRing value={72} label={t('ring', { percent: 72 })} />
        <GlassSurface className="w-72 p-5">
          <GlassSkeleton lines={4} />
        </GlassSurface>
      </div>
    );
  },
};

export const Modal: StoryObj = {
  render: function Render() {
    const t = useTranslations('Glass');
    const [open, setOpen] = useState(false);
    return (
      <>
        <GlassButton
          variant="primary"
          onClick={() => {
            setOpen(true);
          }}
        >
          {t('nav.openMenu')}
        </GlassButton>
        <GlassModal
          open={open}
          onClose={() => {
            setOpen(false);
          }}
          title={t('assistant.title')}
          closeLabel={t('nav.closeMenu')}
        >
          <p className="muted text-sm leading-relaxed">{t('assistant.description')}</p>
        </GlassModal>
      </>
    );
  },
};

export const Waves: StoryObj = {
  render: () => (
    <div className="relative h-72 overflow-hidden rounded-3xl border border-[var(--lg-edge)]">
      <AnimatedWaves />
    </div>
  ),
};
