'use client';

import { useLocale, useTranslations } from 'next-intl';
import type { SubmitEvent } from 'react';
import { useRef, useState } from 'react';

import { CommandMenu } from '@/components/command-menu';
import { LocaleSwitcher } from '@/components/locale-switcher';
import { Link, useRouter } from '@/i18n/navigation';
import { authClient } from '@/lib/auth-client';

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

export function DashboardView({ name, workspaces, projects }: DashboardData & { name: string }) {
  const t = useTranslations('Dashboard');
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

  return (
    <main className="app-shell mx-auto min-h-dvh w-full max-w-6xl space-y-8 px-5 py-7 sm:px-8">
      <header className="flex flex-wrap items-center justify-between gap-4 border-b border-border pb-6">
        <Link href="/" className="font-semibold">
          {t('title')}
        </Link>
        <nav className="flex flex-wrap items-center gap-4" aria-label={t('title')}>
          <CommandMenu />
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
      </header>
      <section className="space-y-3">
        <h1 className="text-3xl font-bold sm:text-4xl">{t('welcome', { name })}</h1>
        <p className="muted max-w-2xl leading-relaxed">{t('description')}</p>
      </section>
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
            <ul className="grid gap-4 sm:grid-cols-2">
              {visibleProjects.map((project) => (
                <li className="surface min-w-0 space-y-4 p-6" key={project.id}>
                  <h3 className="break-words text-xl font-semibold" dir="auto">
                    {project.title}
                  </h3>
                  <p className="muted break-words leading-relaxed" dir="auto">
                    {project.researchQuestion ?? t('questionMissing')}
                  </p>
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
  );
}
