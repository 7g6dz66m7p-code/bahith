'use client';

import type { NotificationEntry, WorkspaceUsage } from '@bahith/db';
import { GlassCard, GlassSurface, ProgressRing, glassButtonProps } from '@bahith/ui';
import {
  BookMarked,
  BookOpen,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Circle,
  Clock,
  Crown,
  FileSearch,
  FileText,
  Fingerprint,
  FolderKanban,
  FolderOpen,
  GitCompareArrows,
  Layers,
  MessageSquarePlus,
  NotebookPen,
  Quote,
  ShieldCheck,
  Sparkles,
  UserCheck,
} from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import type { ReactNode } from 'react';
import { useRef } from 'react';

import { Link } from '@/i18n/navigation';
import type { DashboardOverview, ProjectProgress } from '@/lib/dashboard-overview';
import { WORKFLOW_STEPS } from '@/lib/dashboard-overview';

export interface ProjectTarget {
  workspaceId: string;
  projectId: string;
}

const projectHref = (target: ProjectTarget, section: string) =>
  `/workspaces/${target.workspaceId}/projects/${target.projectId}#${section}`;

const formatDate = (locale: string, iso: string) =>
  new Intl.DateTimeFormat(locale, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'Asia/Baghdad',
  }).format(new Date(iso));

/** A tile that links to a real feature, or says plainly that it is not available. */
function Tile({
  icon,
  label,
  href,
  unavailable,
}: {
  icon: ReactNode;
  label: string;
  href: string | null;
  unavailable: string;
}) {
  const body = (
    <>
      <span aria-hidden="true" className="lg-icon">
        {icon}
      </span>
      <span className="text-sm font-semibold">{label}</span>
      {href === null ? <span className="lg-badge">{unavailable}</span> : null}
    </>
  );
  const className =
    'lg-glass lg-interactive flex min-h-28 flex-col items-center justify-center gap-2 p-3 text-center no-underline';
  return href === null ? (
    <div className={className} aria-disabled="true">
      {body}
    </div>
  ) : (
    <Link className={className} href={href}>
      {body}
    </Link>
  );
}

export function ToolTiles({ latest }: { latest: ProjectTarget | null }) {
  const t = useTranslations('Glass.tools');
  const at = (section: string) => (latest === null ? null : projectHref(latest, section));
  const icon = 'size-8';
  const tiles = [
    { key: 'projects', icon: <FolderKanban className={icon} />, href: '#projects-title' },
    { key: 'sources', icon: <FileSearch className={icon} />, href: at('evidence-title') },
    { key: 'library', icon: <BookOpen className={icon} />, href: at('library-title') },
    { key: 'assistant', icon: <Sparkles className={icon} />, href: at('assistant-title') },
    { key: 'content', icon: <NotebookPen className={icon} />, href: at('highlights-title') },
    { key: 'compare', icon: <GitCompareArrows className={icon} />, href: null, never: true },
    { key: 'references', icon: <Quote className={icon} />, href: at('references-title') },
  ] as const;
  return (
    <nav aria-label={t('title')}>
      <ul className="grid grid-cols-2 gap-3 sm:grid-cols-4 xl:grid-cols-7">
        {tiles.map((tile) => (
          <li key={tile.key}>
            <Tile
              icon={tile.icon}
              label={t(tile.key)}
              href={tile.href}
              unavailable={'never' in tile ? t('unavailable') : t('needsProject')}
            />
          </li>
        ))}
      </ul>
    </nav>
  );
}

export function WorkflowCard({ project }: { project: ProjectProgress | null }) {
  const t = useTranslations('Glass.workflow');
  return (
    <GlassCard title={t('title')} headingId="workflow-title" icon={<Layers className="size-5" />}>
      {project === null ? (
        <p className="muted">{t('empty')}</p>
      ) : (
        <div className="flex flex-wrap items-center justify-around gap-5">
          <ul className="space-y-2.5" aria-label={t('project', { title: project.title })}>
            {WORKFLOW_STEPS.map((step) => (
              <li key={step} className="flex items-center gap-2.5">
                {project.steps[step] ? (
                  <CheckCircle2 aria-hidden="true" className="lg-icon size-5" />
                ) : (
                  <Circle aria-hidden="true" className="muted size-5" />
                )}
                <span>{t(step)}</span>
                <span className="sr-only">{t(project.steps[step] ? 'done' : 'pending')}</span>
              </li>
            ))}
            <li className="flex items-center gap-2.5">
              <Circle aria-hidden="true" className="muted size-5 opacity-60" />
              <span>{t('review')}</span>
              <span className="lg-badge">{t('untracked')}</span>
            </li>
          </ul>
          <div className="text-center">
            <ProgressRing value={project.percent} label={t('ring', { percent: project.percent })} />
            <p className="muted mt-2 max-w-[12rem] text-xs" dir="auto">
              {t('project', { title: project.title })}
            </p>
            <p className="muted max-w-[12rem] text-xs">{t('basis')}</p>
          </div>
        </div>
      )}
    </GlassCard>
  );
}

export function ProjectsCard({ progress }: { progress: ProjectProgress[] }) {
  const t = useTranslations('Glass.projectsCard');
  const locale = useLocale();
  const percentFormat = new Intl.NumberFormat(locale, { style: 'percent' });
  return (
    <GlassCard
      title={t('title')}
      headingId="projects-card-title"
      icon={<FolderOpen className="size-5" />}
      action={
        <a href="#projects-title" className="text-sm underline underline-offset-4">
          {t('viewAll')}
        </a>
      }
    >
      {progress.length === 0 ? (
        <p className="muted">{t('empty')}</p>
      ) : (
        <ul className="space-y-2.5">
          {progress.slice(0, 3).map((project) => (
            <li key={project.projectId}>
              <Link
                href={`/workspaces/${project.workspaceId}/projects/${project.projectId}`}
                className="lg-glass lg-interactive flex items-center gap-3 p-3 no-underline"
                data-elevation="raised"
              >
                <FileText aria-hidden="true" className="lg-icon size-6 shrink-0" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-semibold" dir="auto">
                    {project.title}
                  </span>
                  <span className="muted block text-xs">
                    {t('updated', { date: formatDate(locale, project.lastActivity) })}
                  </span>
                  <span className="lg-progress mt-1.5 block" aria-hidden="true">
                    <span style={{ width: `${String(project.percent)}%` }} />
                  </span>
                  <span className="sr-only">{t('progress', { percent: project.percent })}</span>
                </span>
                <span className="text-sm font-bold tabular-nums" aria-hidden="true">
                  {percentFormat.format(project.percent / 100)}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </GlassCard>
  );
}

export function StatsCard({ overview }: { overview: DashboardOverview }) {
  const t = useTranslations('Glass.stats');
  const locale = useLocale();
  const number = new Intl.NumberFormat(locale);
  const items = [
    { key: 'sources', value: overview.stats.sources, icon: <BookMarked className="size-5" /> },
    { key: 'projects', value: overview.stats.projects, icon: <FolderOpen className="size-5" /> },
    { key: 'drafts', value: overview.stats.drafts, icon: <FileText className="size-5" /> },
    { key: 'notes', value: overview.stats.notes, icon: <NotebookPen className="size-5" /> },
  ] as const;
  const partial = overview.coverage.counted < overview.coverage.total;
  return (
    <GlassCard title={t('title')} headingId="stats-title" icon={<Layers className="size-5" />}>
      <dl className="grid grid-cols-2 gap-3">
        {items.map((item) => (
          <GlassSurface key={item.key} elevation="raised" className="p-3 text-center">
            <span aria-hidden="true" className="lg-icon inline-block">
              {item.icon}
            </span>
            <dd className="text-2xl font-bold tabular-nums">{number.format(item.value)}</dd>
            <dt className="muted text-sm">{t(item.key)}</dt>
          </GlassSurface>
        ))}
      </dl>
      {partial ? (
        <p className="muted mt-3 text-xs">
          {t('partial', { counted: overview.coverage.counted, total: overview.coverage.total })}
        </p>
      ) : null}
      {overview.coverage.failed > 0 ? (
        <p className="error-text mt-1 text-xs">
          {t('failed', { count: overview.coverage.failed })}
        </p>
      ) : null}
    </GlassCard>
  );
}

export function AssistantCard({ latest }: { latest: ProjectTarget | null }) {
  const t = useTranslations('Glass.assistant');
  return (
    <GlassCard
      title={t('title')}
      headingId="assistant-card-title"
      icon={<Sparkles className="size-5" />}
      sheen
    >
      <p className="muted mb-4 text-sm leading-relaxed">{t('description')}</p>
      {latest === null ? (
        <span {...glassButtonProps('glass')} aria-disabled="true">
          {t('needsProject')}
        </span>
      ) : (
        <Link href={projectHref(latest, 'assistant-title')} {...glassButtonProps('primary')}>
          <MessageSquarePlus aria-hidden="true" className="size-5" />
          {t('start')}
        </Link>
      )}
    </GlassCard>
  );
}

export function ActivityFeed({ notifications }: { notifications: NotificationEntry[] }) {
  const t = useTranslations('Glass.activity');
  const kinds = useTranslations('Notifications.kind');
  const locale = useLocale();
  return (
    <GlassCard title={t('title')} headingId="activity-title" icon={<Clock className="size-5" />}>
      {notifications.length === 0 ? (
        <p className="muted text-sm">{t('empty')}</p>
      ) : (
        <ul className="space-y-2.5">
          {notifications.map((item) => (
            <li key={item.id}>
              <GlassSurface elevation="raised" className="p-3 text-sm">
                <p className="leading-relaxed">
                  {kinds.rich(item.kind, {
                    project: item.projectTitle ?? '',
                    workspace: item.workspaceName,
                    name: (chunks) => (
                      <strong dir="auto" className="font-semibold">
                        {chunks}
                      </strong>
                    ),
                  })}
                </p>
                <p className="muted mt-1 text-xs">
                  <time dateTime={item.createdAt}>{formatDate(locale, item.createdAt)}</time>
                </p>
              </GlassSurface>
            </li>
          ))}
        </ul>
      )}
      <Link
        href="/notifications"
        className="mt-3 inline-block text-sm underline underline-offset-4"
      >
        {t('all')}
      </Link>
    </GlassCard>
  );
}

export function SourcesShelf({ sources }: { sources: DashboardOverview['recentSources'] }) {
  const t = useTranslations('Glass.shelf');
  const list = useRef<HTMLUListElement>(null);
  // "Next" moves toward the inline end, which is leftward in right-to-left layouts.
  const scroll = (direction: 1 | -1) => {
    const element = list.current;
    if (element === null) return;
    const rtl = getComputedStyle(element).direction === 'rtl';
    element.scrollBy({ left: direction * (rtl ? -1 : 1) * 220, behavior: 'smooth' });
  };
  return (
    <GlassCard
      title={t('title')}
      headingId="shelf-title"
      icon={<BookMarked className="size-5" />}
      action={
        sources.length > 2 ? (
          <span className="flex gap-1">
            <button
              type="button"
              {...glassButtonProps('glass', 'icon')}
              aria-label={t('previous')}
              onClick={() => {
                scroll(-1);
              }}
            >
              <ChevronLeft aria-hidden="true" className="size-5 rtl:rotate-180" />
            </button>
            <button
              type="button"
              {...glassButtonProps('glass', 'icon')}
              aria-label={t('next')}
              onClick={() => {
                scroll(1);
              }}
            >
              <ChevronRight aria-hidden="true" className="size-5 rtl:rotate-180" />
            </button>
          </span>
        ) : null
      }
    >
      {sources.length === 0 ? (
        <p className="muted text-sm">{t('empty')}</p>
      ) : (
        <ul
          ref={list}
          className="flex snap-x gap-3 overflow-x-auto pb-2"
          tabIndex={0}
          aria-labelledby="shelf-title"
        >
          {sources.map((source, index) => (
            <li key={`${source.projectId}-${source.sourceId}`} className="snap-start">
              <Link
                href={`/workspaces/${source.workspaceId}/projects/${source.projectId}#library-title`}
                className="lg-book lg-interactive flex h-40 w-28 flex-col justify-between p-3 text-start no-underline"
                data-tone={String(index % 4)}
              >
                <span className="line-clamp-4 text-sm font-bold leading-snug" dir="auto">
                  {source.title}
                </span>
                <span className="text-xs">
                  {source.year ?? ''}
                  <span className="block font-semibold">
                    {source.verified ? t('verified') : t('unverified')}
                  </span>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </GlassCard>
  );
}

export function SanadCard({ latest }: { latest: ProjectTarget | null }) {
  const t = useTranslations('Glass.sanad');
  const actions = [
    { key: 'claims', icon: <ShieldCheck className="size-5" />, section: 'assistant-title' },
    { key: 'quotes', icon: <Quote className="size-5" />, section: 'evidence-title' },
    { key: 'plagiarism', icon: <Fingerprint className="size-5" />, section: null },
    { key: 'review', icon: <UserCheck className="size-5" />, section: 'drafts-title' },
  ] as const;
  return (
    <GlassCard
      title={
        <span lang="en" dir="ltr">
          {t('title')}
        </span>
      }
      headingId="sanad-title"
      icon={<ShieldCheck className="size-5" />}
      sheen
    >
      <p className="muted mb-4 text-sm">{t('description')}</p>
      <ul className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
        {actions.map((action) => {
          const href =
            action.section === null || latest === null ? null : projectHref(latest, action.section);
          return (
            <li key={action.key}>
              <Tile
                icon={action.icon}
                label={t(action.key)}
                href={href}
                unavailable={action.section === null ? t('unavailable') : t('needsProject')}
              />
            </li>
          );
        })}
      </ul>
    </GlassCard>
  );
}

export function PlanCard({ usage }: { usage: WorkspaceUsage | null }) {
  const t = useTranslations('Glass.plan');
  return (
    <GlassSurface elevation="raised" className="p-4 text-sm">
      <p className="flex items-center gap-2 font-bold">
        <Crown aria-hidden="true" className="lg-icon size-5" />
        {t('current', { name: usage?.plan?.name ?? t('none') })}
      </p>
      {usage === null ? null : (
        <p className="muted mt-1">
          {usage.aiRequests.limit === null
            ? t('aiNoLimit', { used: usage.aiRequests.used })
            : t('ai', { used: usage.aiRequests.used, limit: usage.aiRequests.limit })}
        </p>
      )}
    </GlassSurface>
  );
}
