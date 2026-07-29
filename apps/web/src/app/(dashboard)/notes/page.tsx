'use client';

import Link from 'next/link';
import { useCallback, useEffect, useId, useMemo, useState } from 'react';
import { LiveIndicator } from '@/components/LiveIndicator';
import { RoleColorDot } from '@/components/RoleColorDot';

interface FeedNote {
  id: string;
  player_id: string;
  target: { id: string; name: string };
  author: { id: string; name: string; role_color: string | null; role_name: string | null };
  body: string;
  created_at: string;
  updated_at: string | null;
  edited: boolean;
  deleted: boolean;
  deleted_at: string | null;
  deleted_by: { id: string; name: string | null } | null;
}

interface FeedResponse {
  items: FeedNote[];
  next_cursor: string | null;
  can_view_deleted: boolean;
}

interface Author {
  id: string;
  name: string;
  role_color: string | null;
  role_name: string | null;
}

const BODY_TRUNCATE = 160;

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString('ru-RU');
}

function buildParams(filters: {
  q: string;
  player: string;
  author: string;
  dateFrom: string;
  dateTo: string;
  includeDeleted: boolean;
  canViewDeleted: boolean;
}): URLSearchParams {
  const params = new URLSearchParams();
  if (filters.q.trim()) params.set('q', filters.q.trim());
  if (filters.player.trim()) params.set('player', filters.player.trim());
  if (filters.author) params.set('author', filters.author);
  if (filters.dateFrom) params.set('dateFrom', `${filters.dateFrom}T00:00:00`);
  if (filters.dateTo) params.set('dateTo', `${filters.dateTo}T23:59:59`);
  if (filters.canViewDeleted && filters.includeDeleted) params.set('includeDeleted', 'true');
  return params;
}

export default function NotesFeedPage() {
  const [rows, setRows] = useState<FeedNote[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [canViewDeleted, setCanViewDeleted] = useState(false);
  const [authors, setAuthors] = useState<Author[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdate, setLastUpdate] = useState<Date | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const [q, setQ] = useState('');
  const [player, setPlayer] = useState('');
  const [author, setAuthor] = useState('');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [includeDeleted, setIncludeDeleted] = useState(false);

  const searchId = useId();
  const playerId = useId();
  const authorId = useId();
  const fromId = useId();
  const toId = useId();

  const filters = useMemo(
    () => ({ q, player, author, dateFrom, dateTo, includeDeleted, canViewDeleted }),
    [q, player, author, dateFrom, dateTo, includeDeleted, canViewDeleted],
  );

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = buildParams(filters);
      const res = await fetch(`/api/v1/notes?${params.toString()}`, {
        credentials: 'include',
        cache: 'no-store',
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as FeedResponse;
      setRows(body.items);
      setNextCursor(body.next_cursor);
      setCanViewDeleted(body.can_view_deleted);
      setLastUpdate(new Date());
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [filters]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    fetch('/api/v1/notes/authors', { credentials: 'include', cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : { items: [] }))
      .then((body: { items: Author[] }) => setAuthors(body.items))
      .catch(() => setAuthors([]));
  }, []);

  async function loadMore() {
    if (!nextCursor || busy) return;
    setBusy(true);
    setError(null);
    try {
      const params = buildParams(filters);
      params.set('cursor', nextCursor);
      const res = await fetch(`/api/v1/notes?${params.toString()}`, {
        credentials: 'include',
        cache: 'no-store',
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as FeedResponse;
      setRows((prev) => [...prev, ...body.items]);
      setNextCursor(body.next_cursor);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function exportCsv() {
    setBusy(true);
    setError(null);
    try {
      const params = buildParams(filters);
      const res = await fetch(`/api/v1/notes/export?${params.toString()}`, {
        credentials: 'include',
        cache: 'no-store',
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `notes-${new Date().toISOString().slice(0, 10)}.csv`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function toggleExpand(id: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  return (
    <div className="space-y-6 max-w-6xl">
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold">Заметки</h1>
        <LiveIndicator lastUpdate={lastUpdate} />
      </div>

      <p className="text-sm text-neutral-400">
        Кросс-игровая лента заметок админов по всем игрокам: накопленное знание о игроках и
        подотчётность стаффа.
      </p>

      {error ? (
        <div className="rounded border border-red-900 bg-red-950 p-3 text-sm text-red-200">
          Ошибка: {error}
        </div>
      ) : null}

      <div className="flex flex-wrap items-end gap-3">
        <div className="flex-1 min-w-48">
          <label className="mb-1 block text-xs text-neutral-500" htmlFor={searchId}>
            Поиск по тексту
          </label>
          <input
            id={searchId}
            type="text"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="фрагмент заметки"
            className="w-full rounded border border-neutral-800 bg-neutral-900 px-3 py-2 text-sm focus:border-neutral-600 focus:outline-none"
          />
        </div>
        <div className="flex-1 min-w-40">
          <label className="mb-1 block text-xs text-neutral-500" htmlFor={playerId}>
            Целевой игрок
          </label>
          <input
            id={playerId}
            type="text"
            value={player}
            onChange={(e) => setPlayer(e.target.value)}
            placeholder="ник (с учётом истории)"
            className="w-full rounded border border-neutral-800 bg-neutral-900 px-3 py-2 text-sm focus:border-neutral-600 focus:outline-none"
          />
        </div>
        <div>
          <label className="mb-1 block text-xs text-neutral-500" htmlFor={authorId}>
            Автор
          </label>
          <select
            id={authorId}
            value={author}
            onChange={(e) => setAuthor(e.target.value)}
            className="rounded border border-neutral-800 bg-neutral-900 px-3 py-2 text-sm focus:border-neutral-600 focus:outline-none"
          >
            <option value="">Все</option>
            {authors.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="mb-1 block text-xs text-neutral-500" htmlFor={fromId}>
            С даты
          </label>
          <input
            id={fromId}
            type="date"
            value={dateFrom}
            onChange={(e) => setDateFrom(e.target.value)}
            className="rounded border border-neutral-800 bg-neutral-900 px-3 py-2 text-sm focus:border-neutral-600 focus:outline-none"
          />
        </div>
        <div>
          <label className="mb-1 block text-xs text-neutral-500" htmlFor={toId}>
            По дату
          </label>
          <input
            id={toId}
            type="date"
            value={dateTo}
            onChange={(e) => setDateTo(e.target.value)}
            className="rounded border border-neutral-800 bg-neutral-900 px-3 py-2 text-sm focus:border-neutral-600 focus:outline-none"
          />
        </div>
        {canViewDeleted ? (
          <label className="flex items-center gap-2 pb-2 text-sm text-neutral-300">
            <input
              type="checkbox"
              checked={includeDeleted}
              onChange={(e) => setIncludeDeleted(e.target.checked)}
            />
            Показывать удалённые
          </label>
        ) : null}
        <button
          type="button"
          onClick={() => void exportCsv()}
          disabled={busy}
          className="ml-auto rounded border border-neutral-700 px-4 py-2 text-sm text-neutral-200 hover:border-neutral-500 disabled:opacity-40"
        >
          Экспорт CSV
        </button>
      </div>

      <section className="rounded border border-neutral-800 bg-neutral-950 p-4">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-xs uppercase text-neutral-500">
              <tr>
                <th className="py-2 pr-3">Дата</th>
                <th className="py-2 pr-3">Автор</th>
                <th className="py-2 pr-3">Игрок</th>
                <th className="py-2 pr-3">Заметка</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan={4} className="py-3 text-center text-xs text-neutral-500">
                    Загрузка…
                  </td>
                </tr>
              ) : rows.length === 0 ? (
                <tr>
                  <td colSpan={4} className="py-3 text-center text-xs text-neutral-500">
                    Заметок не найдено.
                  </td>
                </tr>
              ) : (
                rows.map((note) => {
                  const isExpanded = expanded.has(note.id);
                  const isLong = note.body.length > BODY_TRUNCATE;
                  const shown =
                    isExpanded || !isLong ? note.body : `${note.body.slice(0, BODY_TRUNCATE)}…`;
                  return (
                    <tr key={note.id} className="border-t border-neutral-900 align-top">
                      <td className="py-2 pr-3 whitespace-nowrap text-neutral-400">
                        {formatDate(note.created_at)}
                        {note.edited ? <span className="ml-1 text-neutral-600">(изм.)</span> : null}
                      </td>
                      <td className="py-2 pr-3 whitespace-nowrap">
                        <span className="inline-flex items-center gap-2">
                          <RoleColorDot color={note.author.role_color ?? 'neutral'} size="sm" />
                          <span className="text-neutral-200">{note.author.name}</span>
                        </span>
                      </td>
                      <td className="py-2 pr-3 whitespace-nowrap">
                        <Link
                          href={`/all-players/${note.player_id}#notes`}
                          className="text-sky-400 hover:text-sky-300"
                        >
                          {note.target.name}
                        </Link>
                      </td>
                      <td className="py-2 pr-3">
                        <span
                          className={`whitespace-pre-wrap break-words ${
                            note.deleted ? 'text-neutral-500 line-through' : 'text-neutral-100'
                          }`}
                        >
                          {shown}
                        </span>
                        {isLong ? (
                          <button
                            type="button"
                            onClick={() => toggleExpand(note.id)}
                            className="ml-2 align-baseline text-xs text-sky-400 hover:text-sky-300 no-underline"
                          >
                            {isExpanded ? 'свернуть' : 'ещё'}
                          </button>
                        ) : null}
                        {note.deleted ? (
                          <div className="mt-1 text-xs text-red-400">
                            удалено{note.deleted_by?.name ? `: ${note.deleted_by.name}` : ''}
                          </div>
                        ) : null}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
        {nextCursor ? (
          <div className="mt-3 flex justify-center">
            <button
              type="button"
              onClick={() => void loadMore()}
              disabled={busy}
              className="rounded border border-neutral-800 px-4 py-1.5 text-xs hover:border-neutral-600 disabled:opacity-40"
            >
              {busy ? '…' : 'Показать ещё'}
            </button>
          </div>
        ) : null}
      </section>
    </div>
  );
}
