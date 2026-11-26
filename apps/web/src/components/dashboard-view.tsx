'use client';

import { useLocale, useTranslations } from 'next-intl';
import type { SubmitEvent } from 'react';
import { useRef, useState } from 'react';

import { AdaptiveMotion, GlassSurface } from '@bahith/ui';

import { CommandMenu } from '@/components/command-menu';
import { ActivityCard } from '@/components/dashboard/activity-card';
import { BrandLockup } from '@/components/dashboard/brand-mark';
import { DashboardSidebar } from '@/components/dashboard/dashboard-sidebar';
import {
  ActivityFeed,
  AssistantCard,
  ProjectsCard,
  SanadCard,
  SourcesShelf,
  StatsCard,
  ToolTiles,
  WorkflowCard,
} from '@/components/dashboard/panels';
import { ResearchSearch } from '@/components/dashboard/research-search';
import { LocaleSwitcher } from '@/components/locale-switcher';
import { NotificationBell } from '@/components/notification-bell';
import { Link, useRouter } from '@/i18n/navigation';
import { authClient } from '@/lib/auth-client';
import type { DashboardExtras } from '@/server/dashboard';

function formText(data: FormData, key: string, fallback = ''): string {
  const value = data.get(key);
  return typeof value === 'string' ? value : fallback;
}

interface WorkspaceSummary {
  id: string;
  name: string;
  role: 'owner' | 'editor' | 'viewer' | 'supervisor';
}

export interface DashboardData {
  workspaces: WorkspaceSummary[];
  projects: {
    id: string;
    workspaceId: string;
    title: string;
    researchQuestion: string | null;
    language: 'ar' | 'en';
    createdAt: string;
  }[];
}

const roleKey = {
  owner: 'roleOwner',
  editor: 'roleEditor',
  viewer: 'roleViewer',
  supervisor: 'roleSupervisor',
} as const;

export function DashboardView({
  name,
  workspaces,
  projects,
  unreadNotifications,
  extras,
}: DashboardData & { name: string; unreadNotifications: number; extras: DashboardExtras }) {
  const t = useTranslations('Dashboard');
  const glass = useTranslations('Glass');
  const { overview } = extras;
  // The project the shortcuts open: the one with the most recent activity.
  const active = overview.progress[0] ?? null;
  const latest =
    active === null
      ? projects[0] === undefined
        ? null
        : { workspaceId: projects[0].workspaceId, projectId: projects[0].id }
      : { workspaceId: active.workspaceId, projectId: active.projectId };
  const members = useTranslations('Members');
  const locale = useLocale();
  const router = useRouter();
  const writable = workspaces.filter(
    (workspace) => workspace.role === 'owner' || workspace.role === 'editor',
  );
  const [selectedWorkspace, setSelectedWorkspace] = useState(workspaces[0]?.id ?? '');
  const [creating, setCreating] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const titleInput = useRef<HTMLInputElement>(null);
  const selected = workspaces.find((workspace) => workspace.id === selectedWorkspace);
  const canCreate = selected?.role === 'owner' || selected?.role === 'editor';
  const visibleProjects = projects.filter((project) => project.workspaceId === selectedWorkspace);

  const createProject = async (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    setCreating(true);
    setError('');
    setMessage('');
    try {
      const response = await fetch('/api/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          workspaceId: selectedWorkspace,
          title: formText(data, 'title').trim(),
          researchQuestion: formText(data, 'researchQuestion').trim(),
          language: formText(data, 'language', locale),
        }),
      });
      if (!response.ok) setError(t('createError'));
      else {
        form.reset();
        setShowForm(false);
        setMessage(t('projectCreated'));
        router.refresh();
      }
    } catch {
      setError(t('createError'));
    } finally {
      setCreating(false);
    }
  };

  const signOut = async () => {
    setSigningOut(true);
    setError('');
    try {
      const result = await authClient.signOut();
      if (result.error) setError(t('signOutError'));
      else {
        router.replace('/sign-in');
        router.refresh();
      }
    } catch {
      setError(t('signOutError'));
    } finally {
      setSigningOut(false);
    }
  };

  const searchable = [...overview.progress]
    .filter((project) => project.steps.sources)
    .map((project) => ({
      id: project.projectId,
      workspaceId: project.workspaceId,
      title: project.title,
    }));
  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-[96rem] flex-col gap-4 px-3 py-4 sm:px-5 lg:flex-row lg:gap-5">
      <DashboardSidebar
        latest={latest}
        workspaceId={workspaces[0]?.id ?? null}
        usage={extras.usage?.value ?? null}
      />
      <main className="min-w-0 flex-1 space-y-6 pb-16">
        <GlassSurface
          as="header"
          className="flex flex-wrap items-center justify-between gap-4 rounded-3xl px-4 py-2.5 lg:rounded-full"
          aria-label={glass('topbar.label')}
        >
          <div className="flex min-w-0 items-center gap-3">
            <span
              aria-hidden="true"
              className="grid size-11 shrink-0 place-items-center rounded-full text-lg font-bold"
              style={{ background: 'var(--lg-button-bg)', color: 'var(--lg-button-fg)' }}
            >
              {name.trim().slice(0, 1)}
            </span>
            <div className="min-w-0">
              <h1 className="truncate text-lg font-bold" dir="auto">
                {t('welcome', { name })}
              </h1>
            </div>
          </div>
          <nav className="flex flex-wrap items-center gap-3" aria-label={t('title')}>
            <CommandMenu />
            <NotificationBell count={unreadNotifications} />
            <Link href="/security" className="text-sm underline underline-offset-4">
              {t('security')}
            </Link>
            <LocaleSwitcher />
            <button
              className="btn-secondary"
              type="button"
              disabled={signingOut}
              onClick={() => {
                void signOut();
              }}
            >
              {t('signOut')}
            </button>
          </nav>
        </GlassSurface>

        <AdaptiveMotion className="space-y-5 pt-2 text-center">
          <BrandLockup />
          <p className="text-xl font-bold sm:text-2xl">{glass('tagline')}</p>
          <ul className="muted flex flex-wrap justify-center gap-x-5 gap-y-1 text-sm">
            {(['precise', 'trusted', 'deeper', 'ai'] as const).map((key) => (
              <li key={key}>{glass(`pillars.${key}`)}</li>
            ))}
          </ul>
          <p className="muted mx-auto max-w-2xl text-sm leading-relaxed">{t('description')}</p>
          <ResearchSearch projects={searchable} />
        </AdaptiveMotion>

        <AdaptiveMotion delay={0.05}>
          <ToolTiles latest={latest} />
        </AdaptiveMotion>

        <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_19rem]">
          <div className="min-w-0 space-y-5">
            <AdaptiveMotion
              delay={0.1}
              className="grid gap-5 md:grid-cols-2 min-[1700px]:grid-cols-3"
            >
              <StatsCard overview={overview} />
              <ProjectsCard progress={overview.progress} />
              <WorkflowCard project={active} />
              <SourcesShelf sources={overview.recentSources} />
              <SanadCard latest={latest} />
              <ActivityCard overview={overview} />
            </AdaptiveMotion>
          </div>
          <AdaptiveMotion delay={0.12} className="space-y-5">
            <AssistantCard latest={latest} />
            <ActivityFeed notifications={extras.notifications} />
          </AdaptiveMotion>
        </div>
        {error ? (
          <p className="error-text" role="alert">
            {error}
          </p>
        ) : null}
        {message ? (
          <p className="success-text" role="status">
            {message}
          </p>
        ) : null}
        <div className="grid gap-6 lg:grid-cols-[17rem_1fr]">
          <aside className="surface h-fit space-y-4 p-5" aria-labelledby="workspace-title">
            <h2 className="section-title" id="workspace-title">
              {t('workspaces')}
            </h2>
            {workspaces.length === 0 ? (
              <p className="muted text-sm">{t('noWorkspaces')}</p>
            ) : (
              <div className="space-y-2">
                <label className="block text-sm" htmlFor="workspace-selector">
                  {t('workspace')}
                </label>
                <select
                  id="workspace-selector"
                  className="field"
                  value={selectedWorkspace}
                  onChange={(event) => {
                    setSelectedWorkspace(event.target.value);
                    setShowForm(false);
                    setError('');
                    setMessage('');
                  }}
                >
                  {workspaces.map((workspace) => (
                    <option value={workspace.id} key={workspace.id}>
                      {workspace.name}
                    </option>
                  ))}
                </select>
              </div>
            )}
            {selected ? <p className="muted text-sm">{t(roleKey[selected.role])}</p> : null}
            {selected ? (
              <Link
                className="text-sm underline underline-offset-4"
                href={`/workspaces/${selected.id}/members`}
              >
                {members('manage')}
              </Link>
            ) : null}
            {!canCreate && workspaces.length > 0 ? (
              <p className="muted text-sm">{t('readonlyWorkspace')}</p>
            ) : null}
          </aside>
          <section className="space-y-5" aria-labelledby="projects-title">
            <div className="flex flex-wrap items-center justify-between gap-4">
              <h2 className="section-title" id="projects-title">
                {t('projects')}
              </h2>
              {writable.length > 0 ? (
                <button
                  className="btn"
                  type="button"
                  disabled={!canCreate}
                  aria-expanded={showForm}
                  aria-controls={showForm ? 'new-project-form' : undefined}
                  onClick={() => {
                    setShowForm(!showForm);
                    setError('');
                    setMessage('');
                    if (!showForm) queueMicrotask(() => titleInput.current?.focus());
                  }}
                >
                  {t('newProject')}
                </button>
              ) : null}
            </div>
            {showForm && canCreate ? (
              <form
                method="post"
                id="new-project-form"
                className="surface space-y-5 p-5 sm:p-6"
                onSubmit={(event) => {
                  void createProject(event);
                }}
              >
                <label className="block space-y-2">
                  <span>{t('projectTitle')}</span>
                  <input
                    ref={titleInput}
                    className="field"
                    name="title"
                    required
                    minLength={2}
                    maxLength={200}
                    dir="auto"
                  />
                </label>
                <label className="block space-y-2">
                  <span>{t('researchQuestion')}</span>
                  <textarea
                    className="field min-h-28"
                    name="researchQuestion"
                    maxLength={5000}
                    dir="auto"
                  />
                </label>
                <div className="max-w-xs space-y-2">
                  <label className="block" htmlFor="project-language">
                    {t('language')}
                  </label>
                  <select
                    id="project-language"
                    className="field"
                    name="language"
                    defaultValue={locale}
                  >
                    <option value="ar">{t('arabic')}</option>
                    <option value="en">{t('english')}</option>
                  </select>
                </div>
                <button type="submit" className="btn" disabled={creating}>
                  {t(creating ? 'creating' : 'createProject')}
                </button>
              </form>
            ) : null}
            {visibleProjects.length === 0 ? (
              <div className="surface space-y-3 p-8 sm:p-10">
                <h3 className="text-xl font-semibold">{t('emptyProjects')}</h3>
                <p className="muted leading-relaxed">{t('emptyProjectsDescription')}</p>
              </div>
            ) : (
              <ul className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
                {visibleProjects.map((project, index) => (
                  <li
                    className={`surface min-w-0 space-y-4 p-6 ${index === 0 ? 'sm:col-span-2' : ''}`}
                    key={project.id}
                  >
                    <h3 className="break-words text-xl font-semibold" dir="auto">
                      {project.title}
                    </h3>
                    <p className="muted break-words leading-relaxed" dir="auto">
                      {project.researchQuestion ?? t('questionMissing')}
                    </p>
                    <Link
                      className="btn-secondary inline-block"
                      href={`/workspaces/${project.workspaceId}/projects/${project.id}`}
                    >
                      {t('openProject')}
                    </Link>
                    <div className="muted flex flex-wrap justify-between gap-3 text-sm">
                      <span>{t(project.language === 'ar' ? 'arabic' : 'english')}</span>
                      <time dateTime={project.createdAt}>
                        {new Intl.DateTimeFormat(locale, {
                          year: 'numeric',
                          month: 'short',
                          day: 'numeric',
                          timeZone: 'Asia/Baghdad',
                        }).format(new Date(project.createdAt))}
                      </time>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      </main>
    </div>
  );
}
