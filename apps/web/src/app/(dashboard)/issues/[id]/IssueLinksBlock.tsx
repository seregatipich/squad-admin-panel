'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';

import { type PickedPlayer, PlayerSearchSelect } from '../PlayerSearchSelect';
import {
  canRemoveLink,
  entityTypeLabel,
  type IssueLinkEntityType,
  type IssueLinkView,
  type IssueLinkViewer,
  linkErrorMessage,
  sortLinks,
} from './issue-links';

interface ServerOption {
  id: string;
  display_name: string;
}

/**
 * «Связанные объекты» on the ticket card (ISSUE-3, #156). Links come from the
 * page's own `GET /api/v1/issues/:id` payload; every mutation calls
 * {@link onChanged} so the page refetches instead of this block keeping a
 * second copy of the list.
 *
 * The server picker is offered only when `GET /api/v1/servers` succeeds — that
 * route requires `server:view`, which a panel user working the tracker need not
 * have, so a 403 hides the option rather than breaking the block.
 */
export function IssueLinksBlock({
  issueId,
  links,
  viewer,
  onChanged,
}: {
  issueId: string;
  links: IssueLinkView[];
  viewer: IssueLinkViewer | null;
  onChanged: () => void;
}) {
  const [servers, setServers] = useState<ServerOption[]>([]);
  const [entityType, setEntityType] = useState<IssueLinkEntityType>('player');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/v1/servers', { credentials: 'include', cache: 'no-store' })
      .then(async (res) => (res.ok ? ((await res.json()) as { items: ServerOption[] }) : null))
      .then((body) => {
        if (!cancelled && body) setServers(body.items);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  async function mutate(request: () => Promise<Response>) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await request();
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setError(linkErrorMessage(res.status, body.error));
        return;
      }
      onChanged();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function attach(type: IssueLinkEntityType, entityId: string) {
    return mutate(() =>
      fetch(`/api/v1/issues/${issueId}/links`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ entity_type: type, entity_id: entityId }),
      }),
    );
  }

  function detach(linkId: string) {
    return mutate(() =>
      fetch(`/api/v1/issues/${issueId}/links/${linkId}`, {
        method: 'DELETE',
        credentials: 'include',
      }),
    );
  }

  const ordered = sortLinks(links);

  return (
    <section className="rounded border border-neutral-800 bg-neutral-950 p-4 space-y-3">
      <h2 className="text-xs uppercase tracking-widest text-neutral-400">
        Связанные объекты
        <span className="ml-2 rounded-full bg-neutral-800 px-2 py-0.5 text-[11px] text-neutral-200 tabular-nums">
          {ordered.length}
        </span>
      </h2>

      {ordered.length === 0 ? (
        <div className="rounded border border-dashed border-neutral-800 p-6 text-center text-sm text-neutral-500">
          Связанных объектов нет.
        </div>
      ) : (
        <ul className="space-y-1">
          {ordered.map((link) => (
            <li
              key={link.id}
              className="flex items-center gap-2 rounded border border-neutral-900 bg-neutral-900/40 px-3 py-1.5 text-sm"
            >
              <span className="rounded bg-neutral-800 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-neutral-400">
                {entityTypeLabel(link.entity_type)}
              </span>
              {link.ref ? (
                <Link href={link.ref} className="text-sky-400 hover:text-sky-300">
                  {link.label}
                </Link>
              ) : (
                <span className="text-neutral-500 line-through">{link.label}</span>
              )}
              {canRemoveLink(link, viewer) ? (
                <button
                  type="button"
                  aria-label={`Удалить связь: ${link.label}`}
                  disabled={busy}
                  onClick={() => void detach(link.id)}
                  className="ml-auto rounded border border-neutral-800 px-2 py-0.5 text-xs text-neutral-400 hover:border-red-900 hover:text-red-300 disabled:opacity-40"
                >
                  ✕
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <label className="text-xs text-neutral-500" htmlFor="issue-link-entity-type">
          Тип объекта
        </label>
        <select
          id="issue-link-entity-type"
          value={entityType}
          disabled={busy}
          onChange={(e) => {
            setEntityType(e.target.value as IssueLinkEntityType);
            setError(null);
          }}
          className="rounded border border-neutral-800 bg-neutral-950 px-2 py-1 text-xs outline-none focus:border-neutral-600"
        >
          <option value="player">{entityTypeLabel('player')}</option>
          {servers.length > 0 ? <option value="server">{entityTypeLabel('server')}</option> : null}
        </select>

        {entityType === 'player' ? (
          <div className="w-64">
            <PlayerSearchSelect
              placeholder="Связать с игроком"
              disabled={busy}
              onSelect={(player: PickedPlayer) => void attach('player', player.id)}
            />
          </div>
        ) : (
          <select
            aria-label="Сервер для связи"
            defaultValue=""
            disabled={busy}
            onChange={(e) => {
              if (e.target.value) void attach('server', e.target.value);
            }}
            className="rounded border border-neutral-800 bg-neutral-950 px-2 py-1 text-xs outline-none focus:border-neutral-600"
          >
            <option value="">Выберите сервер…</option>
            {servers.map((server) => (
              <option key={server.id} value={server.id}>
                {server.display_name}
              </option>
            ))}
          </select>
        )}
      </div>

      {error ? (
        <div className="rounded border border-red-900 bg-red-950 p-2 text-xs text-red-200">
          {error}
        </div>
      ) : null}
    </section>
  );
}
