'use client';

import type { CollectionEntry } from '@bahith/db';
import { useTranslations } from 'next-intl';
import type { SubmitEvent } from 'react';
import { useCallback, useState } from 'react';

type Notice = { kind: 'error' | 'success'; key: SuccessKey | ErrorKey };
type SuccessKey = 'created' | 'renamed' | 'deleted' | 'added' | 'removed';
type ErrorKey = 'nameTaken' | 'invalidName' | 'notInProject' | 'error';

const ERROR_KEYS: Record<string, ErrorKey> = {
  LIBRARY_NAME_TAKEN: 'nameTaken',
  SANAD_INVALID_INPUT: 'invalidName',
  SANAD_SOURCE_MISMATCH: 'notInProject',
};

export interface CollectionsState {
  collections: CollectionEntry[];
  busy: boolean;
  notice: Notice | null;
  create: (name: string) => Promise<boolean>;
  rename: (collectionId: string, name: string) => Promise<boolean>;
  remove: (collectionId: string) => Promise<boolean>;
  addSource: (collectionId: string, sourceId: string) => Promise<boolean>;
  removeSource: (collectionId: string, sourceId: string) => Promise<boolean>;
}

/** The project's collections, loaded from and changed through the collections API. */
export function useCollections(
  projectId: string,
  workspaceId: string,
  initial: CollectionEntry[],
): CollectionsState {
  const [collections, setCollections] = useState<CollectionEntry[]>(initial);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const base = `/api/projects/${projectId}/collections`;
  const query = `workspaceId=${workspaceId}`;

  const refresh = useCallback(async () => {
    const response = await fetch(`${base}?${query}`, { cache: 'no-store' });
    if (response.ok) {
      setCollections(((await response.json()) as { collections: CollectionEntry[] }).collections);
    }
  }, [base, query]);

  const mutate = async (path: string, init: RequestInit, success: SuccessKey): Promise<boolean> => {
    setBusy(true);
    setNotice(null);
    try {
      const response = await fetch(`${base}${path}?${query}`, init);
      if (!response.ok) {
        const payload = (await response.json().catch(() => ({}))) as { code?: string };
        setNotice({ kind: 'error', key: ERROR_KEYS[payload.code ?? ''] ?? 'error' });
        return false;
      }
      setNotice({ kind: 'success', key: success });
      await refresh();
      return true;
    } catch {
      setNotice({ kind: 'error', key: 'error' });
      return false;
    } finally {
      setBusy(false);
    }
  };

  const json = (method: string, body: unknown): RequestInit => ({
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  return {
    collections,
    busy,
    notice,
    create: (name) => mutate('', json('POST', { name }), 'created'),
    rename: (collectionId, name) => mutate(`/${collectionId}`, json('PATCH', { name }), 'renamed'),
    remove: (collectionId) => mutate(`/${collectionId}`, { method: 'DELETE' }, 'deleted'),
    addSource: (collectionId, sourceId) =>
      mutate(`/${collectionId}/sources/${sourceId}`, { method: 'PUT' }, 'added'),
    removeSource: (collectionId, sourceId) =>
      mutate(`/${collectionId}/sources/${sourceId}`, { method: 'DELETE' }, 'removed'),
  };
}

/**
 * Collections of the library: filter the list by one, and (owner/editor) create, rename
 * or delete them. Deleting a collection never removes its sources from the library.
 */
export function CollectionsToolbar({
  state,
  canWrite,
  selected,
  onSelect,
}: {
  state: CollectionsState;
  canWrite: boolean;
  selected: string | null;
  onSelect: (collectionId: string | null) => void;
}) {
  const t = useTranslations('Collections');
  const current = state.collections.find((collection) => collection.id === selected) ?? null;

  const create = async (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    const name = new FormData(form).get('name');
    if (typeof name !== 'string' || name.trim() === '') return;
    if (await state.create(name)) form.reset();
  };

  const rename = (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    const name = new FormData(event.currentTarget).get('name');
    if (current === null || typeof name !== 'string' || name.trim() === '') return;
    void state.rename(current.id, name);
  };

  const remove = async () => {
    if (current === null) return;
    if (await state.remove(current.id)) onSelect(null);
  };

  return (
    <div className="space-y-3 rounded-xl border border-border p-4" data-testid="collections">
      <h3 className="font-semibold">{t('title')}</h3>
      {state.collections.length === 0 ? (
        <p className="muted text-sm">{t('none')}</p>
      ) : (
        <div className="space-y-1">
          <label className="block text-sm font-medium" htmlFor="collection-filter">
            {t('filterLabel')}
          </label>
          <select
            id="collection-filter"
            className="field"
            value={current?.id ?? ''}
            onChange={(event) => {
              onSelect(event.target.value === '' ? null : event.target.value);
            }}
          >
            <option value="">{t('all')}</option>
            {state.collections.map((collection) => (
              <option key={collection.id} value={collection.id}>
                {t('option', { name: collection.name, count: collection.sourceCount })}
              </option>
            ))}
          </select>
        </div>
      )}

      {canWrite ? (
        <form
          method="post"
          className="flex flex-wrap items-end gap-2"
          onSubmit={(event) => void create(event)}
        >
          <div className="min-w-0 flex-1 space-y-1">
            <label className="block text-sm font-medium" htmlFor="collection-name">
              {t('nameLabel')}
            </label>
            <input
              id="collection-name"
              name="name"
              className="field"
              dir="auto"
              maxLength={120}
              required
            />
          </div>
          <button className="btn-secondary" type="submit" disabled={state.busy}>
            {t('create')}
          </button>
        </form>
      ) : null}

      {canWrite && current !== null ? (
        <div className="space-y-2">
          <form
            method="post"
            className="flex flex-wrap items-end gap-2"
            onSubmit={rename}
            key={current.id}
          >
            <div className="min-w-0 flex-1 space-y-1">
              <label className="block text-sm font-medium" htmlFor="collection-rename">
                {t('renameLabel')}
              </label>
              <input
                id="collection-rename"
                name="name"
                className="field"
                dir="auto"
                maxLength={120}
                defaultValue={current.name}
                required
              />
            </div>
            <button className="btn-secondary" type="submit" disabled={state.busy}>
              {t('rename')}
            </button>
          </form>
          <button
            className="btn-secondary"
            type="button"
            disabled={state.busy}
            aria-describedby="collection-delete-hint"
            onClick={() => void remove()}
          >
            {t('delete')}
          </button>
          <p id="collection-delete-hint" className="muted text-sm">
            {t('deleteHint')}
          </p>
        </div>
      ) : null}

      {state.notice === null ? null : (
        <p
          className={state.notice.kind === 'error' ? 'error-text text-sm' : 'success-text text-sm'}
          role={state.notice.kind === 'error' ? 'alert' : 'status'}
        >
          {t(state.notice.key)}
        </p>
      )}
    </div>
  );
}

/** The collections one source belongs to, with add/remove controls for owners and editors. */
export function SourceCollections({
  state,
  canWrite,
  sourceId,
  title,
}: {
  state: CollectionsState;
  canWrite: boolean;
  sourceId: string;
  title: string;
}) {
  const t = useTranslations('Collections');
  const [choice, setChoice] = useState('');
  const memberOf = state.collections.filter((c) => c.sourceIds.includes(sourceId));
  const available = state.collections.filter((c) => !c.sourceIds.includes(sourceId));
  if (memberOf.length === 0 && (!canWrite || available.length === 0)) return null;
  const selectId = `add-to-collection-${sourceId}`;

  return (
    <div className="mt-3 space-y-2 text-sm">
      {memberOf.length === 0 ? null : (
        <div className="flex flex-wrap items-center gap-2">
          <span className="muted">{t('memberOf')}</span>
          <ul className="flex flex-wrap gap-2" aria-label={t('memberOf')}>
            {memberOf.map((collection) => (
              <li
                key={collection.id}
                className="inline-flex items-center gap-1 rounded-full border border-border px-3 py-0.5"
              >
                <span dir="auto">{collection.name}</span>
                {canWrite ? (
                  <button
                    type="button"
                    className="ms-1 inline-flex size-6 items-center justify-center rounded-full"
                    disabled={state.busy}
                    aria-label={t('removeFrom', { title, name: collection.name })}
                    onClick={() => void state.removeSource(collection.id, sourceId)}
                  >
                    <svg aria-hidden="true" viewBox="0 0 16 16" className="size-3">
                      <path
                        d="M4 4l8 8M12 4l-8 8"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                      />
                    </svg>
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      )}
      {canWrite && available.length > 0 ? (
        <div className="flex flex-wrap items-center gap-2">
          <label className="sr-only" htmlFor={selectId}>
            {t('addLabel', { title })}
          </label>
          <select
            id={selectId}
            className="field max-w-xs"
            value={choice}
            onChange={(event) => {
              setChoice(event.target.value);
            }}
          >
            <option value="">{t('addPlaceholder')}</option>
            {available.map((collection) => (
              <option key={collection.id} value={collection.id}>
                {collection.name}
              </option>
            ))}
          </select>
          <button
            className="btn-secondary"
            type="button"
            disabled={state.busy || choice === ''}
            onClick={() => {
              void state.addSource(choice, sourceId).then((ok) => {
                if (ok) setChoice('');
              });
            }}
          >
            {t('add')}
          </button>
        </div>
      ) : null}
    </div>
  );
}
