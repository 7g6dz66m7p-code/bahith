'use client';

import { GlassSearch, GlassSurface } from '@bahith/ui';
import { FileUp, Search } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useState } from 'react';

import { Link } from '@/i18n/navigation';

interface ProjectOption {
  id: string;
  workspaceId: string;
  title: string;
}

interface Passage {
  chunkId: string;
  fileId: string | null;
  sourceTitle: string;
  content: string;
  pageStart: number | null;
}

/**
 * The hero search: SANAD retrieval over the chosen project's uploaded sources (the same
 * /api/sanad/retrieve the project page uses). Each passage shows its stored page and
 * opens the file at that page; nothing is generated.
 */
export function ResearchSearch({ projects }: { projects: ProjectOption[] }) {
  const t = useTranslations('Glass.search');
  const [projectId, setProjectId] = useState(projects[0]?.id ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [results, setResults] = useState<{ project: ProjectOption; passages: Passage[] } | null>(
    null,
  );
  const project = projects.find((item) => item.id === projectId);

  const search = async (query: string) => {
    if (project === undefined) return;
    setBusy(true);
    setError('');
    try {
      const response = await fetch('/api/sanad/retrieve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          workspaceId: project.workspaceId,
          projectId: project.id,
          query,
          limit: 5,
        }),
      });
      if (!response.ok) throw new Error('search failed');
      const payload = (await response.json()) as { results: Passage[] };
      setResults({ project, passages: payload.results });
    } catch {
      setError(t('error'));
      setResults(null);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto w-full max-w-3xl space-y-3" id="research-search">
      <GlassSearch
        label={t('label')}
        placeholder={t('placeholder')}
        submitLabel={busy ? t('searching') : t('submit')}
        busy={busy}
        disabled={project === undefined}
        icon={<Search aria-hidden="true" className="size-5" />}
        onSearch={(query) => {
          void search(query);
        }}
      >
        {projects.length > 1 ? (
          <select
            aria-label={t('scope')}
            className="max-w-[10rem] truncate rounded-full border border-[var(--lg-edge)] bg-transparent px-3 py-2 text-sm"
            value={projectId}
            onChange={(event) => {
              setProjectId(event.target.value);
              setResults(null);
            }}
          >
            {projects.map((item) => (
              <option key={item.id} value={item.id}>
                {item.title}
              </option>
            ))}
          </select>
        ) : null}
        {project === undefined ? null : (
          <Link
            href={`/workspaces/${project.workspaceId}/projects/${project.id}#library-title`}
            className="lg-button lg-interactive"
            data-variant="glass"
            data-size="icon"
            title={t('openSource')}
          >
            <FileUp aria-hidden="true" className="size-5" />
            <span className="sr-only">{t('openSource')}</span>
          </Link>
        )}
      </GlassSearch>
      <p className="muted text-center text-sm">
        {project === undefined ? t('noProject') : t('note')}
      </p>
      {error === '' ? null : (
        <p className="error-text text-center" role="alert">
          {error}
        </p>
      )}
      {results === null ? null : (
        <GlassSurface as="section" elevation="raised" className="p-4" aria-live="polite">
          <h2 className="mb-3 font-bold" dir="auto">
            {t('resultsTitle', { project: results.project.title })}
          </h2>
          {results.passages.length === 0 ? (
            <p className="muted">{t('noResults')}</p>
          ) : (
            <ol className="space-y-3">
              {results.passages.map((passage) => (
                <li
                  key={passage.chunkId}
                  className="border-b border-[var(--lg-edge)] pb-3 last:border-0"
                >
                  <p className="leading-relaxed" dir="auto">
                    {passage.content.length > 320
                      ? `${passage.content.slice(0, 320)}…`
                      : passage.content}
                  </p>
                  <p className="muted mt-1 flex flex-wrap gap-x-3 text-sm">
                    <span dir="auto">{passage.sourceTitle}</span>
                    <span>
                      {passage.pageStart === null
                        ? t('noPage')
                        : t('page', { page: passage.pageStart })}
                    </span>
                    {passage.fileId === null ? null : (
                      <a
                        className="underline underline-offset-4"
                        target="_blank"
                        rel="noreferrer"
                        href={`/api/projects/${results.project.id}/files/${passage.fileId}?workspaceId=${results.project.workspaceId}${passage.pageStart === null ? '' : `#page=${String(passage.pageStart)}`}`}
                      >
                        {t('openSource')}
                      </a>
                    )}
                  </p>
                </li>
              ))}
            </ol>
          )}
        </GlassSurface>
      )}
    </div>
  );
}
