'use client';

import type { WorkspaceUsage } from '@bahith/db';
import { GlassSidebar } from '@bahith/ui';
import type { GlassNavItem } from '@bahith/ui';
import {
  BarChart3,
  BookOpen,
  FolderOpen,
  House,
  Layers,
  Search,
  Settings,
  ShieldCheck,
  Sparkles,
  Users,
} from 'lucide-react';
import { useTranslations } from 'next-intl';

import { Link } from '@/i18n/navigation';

import { BrandLockup } from './brand-mark';
import { PlanCard } from './panels';
import type { ProjectTarget } from './panels';

/** The dashboard's glass navigation; every entry is a real page or section, or says so. */
export function DashboardSidebar({
  latest,
  workspaceId,
  usage,
}: {
  latest: ProjectTarget | null;
  workspaceId: string | null;
  usage: WorkspaceUsage | null;
}) {
  const t = useTranslations('Glass.nav');
  const icon = 'size-5';
  const inProject = (section: string) =>
    latest === null
      ? undefined
      : `/workspaces/${latest.workspaceId}/projects/${latest.projectId}#${section}`;
  const needsProject = latest === null ? t('needsProject') : undefined;
  const items: GlassNavItem[] = [
    {
      key: 'dashboard',
      label: t('dashboard'),
      icon: <House className={icon} />,
      href: '/dashboard',
      current: true,
    },
    {
      key: 'search',
      label: t('search'),
      icon: <Search className={icon} />,
      href: '#research-search',
    },
    {
      key: 'projects',
      label: t('projects'),
      icon: <FolderOpen className={icon} />,
      href: '#projects-title',
    },
    {
      key: 'sources',
      label: t('sources'),
      icon: <Layers className={icon} />,
      ...withHref(inProject('library-title'), needsProject),
    },
    {
      key: 'library',
      label: t('library'),
      icon: <BookOpen className={icon} />,
      ...withHref(inProject('references-title'), needsProject),
    },
    {
      key: 'assistant',
      label: t('assistant'),
      icon: <Sparkles className={icon} />,
      ...withHref(inProject('assistant-title'), needsProject),
    },
    {
      key: 'sanad',
      label: t('sanad'),
      icon: <ShieldCheck className={icon} />,
      ...withHref(inProject('evidence-title'), needsProject),
    },
    {
      key: 'reports',
      label: t('reports'),
      icon: <BarChart3 className={icon} />,
      unavailableLabel: t('unavailable'),
    },
    {
      key: 'teams',
      label: t('teams'),
      icon: <Users className={icon} />,
      ...withHref(
        workspaceId === null ? undefined : `/workspaces/${workspaceId}/members`,
        needsProject,
      ),
    },
    {
      key: 'settings',
      label: t('settings'),
      icon: <Settings className={icon} />,
      href: '/security',
    },
  ];
  return (
    <GlassSidebar
      label={t('label')}
      openMenuLabel={t('openMenu')}
      closeMenuLabel={t('closeMenu')}
      brand={<BrandLockup compact />}
      items={items}
      footer={<PlanCard usage={usage} />}
      renderLink={(item, className, children) =>
        item.href.startsWith('#') ? (
          <a className={className} href={item.href}>
            {children}
          </a>
        ) : (
          <Link
            className={className}
            href={item.href}
            aria-current={item.current === true ? 'page' : undefined}
          >
            {children}
          </Link>
        )
      }
    />
  );
}

function withHref(href: string | undefined, unavailable: string | undefined) {
  return href === undefined
    ? unavailable === undefined
      ? {}
      : { unavailableLabel: unavailable }
    : { href };
}
