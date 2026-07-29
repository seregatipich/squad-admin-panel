'use client';

import Link from 'next/link';
import { useCallback, useEffect, useId, useMemo, useState } from 'react';
import { LiveIndicator } from '@/components/LiveIndicator';
import { RoleColorDot } from '@/components/RoleColorDot';
import { type MarkTypeOption, markIconEmoji, severityTone } from '@/lib/marks';

interface SuspectMark {
  mark_type_id: number;
  slug: string;
  label_en: string;
  label_ru: string;
  icon: string;
  severity: number;
}

interface SuspectRole {
  id: string;
  name: string;
  color: string;
}

interface Suspect {
  id: string;
  steam_id64: string | null;
  eos_id: string | null;
  canonical_name: string;
  last_seen_at: string;
  role: SuspectRole | null;
  marks: SuspectMark[];
  has_active_ban: boolean;
}

interface SuspectsResponse {
  items: Suspect[];
  next_cursor: string | null;
}

type SortOption = 'last_seen_desc' | 'last_seen_asc';

const toneClasses: Record<string, string> = {
  red: 'border-red-800 bg-red-950/70 text-red-200',
  amber: 'border-amber-800 bg-amber-950/70 text-amber-200',
  neutral: 'border-neutral-700 bg-neutral-900 text-neutral-200',
};

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString('ru-RU');
}

function buildParams(filters: {
  markTypeIds: Set<number>;
  q: string;
  noActiveBan: boolean;
  sort: SortOption;
}): URLSearchParams {
  const params = new URLSearchParams();
  if (filters.markTypeIds.size > 0) {
    params.set('mark_type_ids', [...filters.markTypeIds].join(','));
  }
  if (filters.q.trim()) params.set('q', filters.q.trim());
  if (filters.noActiveBan) params.set('no_active_ban', 'true');
  if (filters.sort !== 'last_seen_desc') params.set('sort', filters.sort);
  return params;
}

export function SuspectsBrowser() {
  const [markTypes, setMarkTypes] = useState<MarkTypeOption[]>([]);
  const [rows, setRows] = useState<Suspect[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdate, setLastUpdate] = useState<Date | null>(null);

  const [q, setQ] = useState('');
  const [markTypeIds, setMarkTypeIds] = useState<Set<number>>(new Set());
  const [noActiveBan, setNoActiveBan] = useState(false);
  const [sort, setSort] = useState<SortOption>('last_seen_desc');

  const searchId = useId();
  const sortId = useId();

  useEffect(() => {
    fetch('/api/v1/mark-types', { credentials: 'include', cache: 'no-store' })
      .then((r) => (r.ok ? (r.json() as Promise<MarkTypeOption[]>) : []))
      .then(setMarkTypes)
      .catch(() => setMarkTypes([]));
  }, []);

  const filters = useMemo(
    () => ({ markTypeIds, q, noActiveBan, sort }),
    [markTypeIds, q, noActiveBan, sort],
  );

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = buildParams(filters);
      const res = await fetch(`/api/v1/suspects?${params.toString()}`, {
        credentials: 'include',
        cache: 'no-store',
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as SuspectsResponse;
      setRows(body.items);
      setNextCursor(body.next_cursor);
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

  async function loadMore() {
    if (!nextCursor || busy) return;
    setBusy(true);
    setError(null);
    try {
      const params = buildParams(filters);
      params.set('cursor', nextCursor);
      const res = await fetch(`/api/v1/suspects?${params.toString()}`, {
        credentials: 'include',
        cache: 'no-store',
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as SuspectsResponse;
      setRows((prev) => [...prev, ...body.items]);
      setNextCursor(body.next_cursor);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function toggleMarkType(id: number) {
    setMarkTypeIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  return (
    <div className="space-y-6 max-w-6xl">
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold">Метки</h1>
        <LiveIndicator lastUpdate={lastUpdate} />
      </div>

      <p className="text-sm text-neutral-400">
        Список игроков с активными метками (читерство, гриферство и т.п.): быстрый доступ к
        подозрительным игрокам для проверки и модерации.
      </p>

      {error ? (
        <div className="rounded border border-red-900 bg-red-950 p-3 text-sm text-red-200">
          Ошибка: {error}
        </div>
      ) : null}

      <div className="flex flex-wrap items-end gap-3">
        <div className="flex-1 min-w-48">
          <label className="mb-1 block text-xs text-neutral-500" htmlFor={searchId}>
            Поиск по нику
          </label>
          <input
            id={searchId}
            type="text"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="текущий или прошлый ник"
            className="w-full rounded border border-neutral-800 bg-neutral-900 px-3 py-2 text-sm focus:border-neutral-600 focus:outline-none"
          />
        </div>
        <div>
          <label className="mb-1 block text-xs text-neutral-500" htmlFor={sortId}>
            Сортировка
          </label>
          <select
            id={sortId}
            value={sort}
            onChange={(e) => setSort(e.target.value as SortOption)}
            className="rounded border border-neutral-800 bg-neutral-900 px-3 py-2 text-sm focus:border-neutral-600 focus:outline-none"
          >
            <option value="last_seen_desc">Недавно на сервере</option>
            <option value="last_seen_asc">Давно не заходили</option>
          </select>
        </div>
        <label className="flex items-center gap-2 pb-2 text-sm text-neutral-300">
          <input
            type="checkbox"
            checked={noActiveBan}
            onChange={(e) => setNoActiveBan(e.target.checked)}
          />
          Без активного бана
        </label>
      </div>

      <div className="flex flex-wrap gap-2">
        {markTypes.map((type) => {
          const active = markTypeIds.has(type.id);
          return (
            <button
              key={type.id}
              type="button"
              onClick={() => toggleMarkType(type.id)}
              className={`inline-flex items-center gap-1.5 rounded border px-2.5 py-1 text-xs transition-colors ${
                active
                  ? toneClasses[severityTone(type.severity)]
                  : 'border-neutral-800 bg-neutral-950 text-neutral-400 hover:border-neutral-600'
              }`}
            >
              <span aria-hidden>{markIconEmoji(type.icon)}</span>
              <span>{type.label_ru}</span>
            </button>
          );
        })}
      </div>

      <section className="rounded border border-neutral-800 bg-neutral-950 p-4">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-xs uppercase text-neutral-500">
              <tr>
                <th className="py-2 pr-3">Игрок</th>
                <th className="py-2 pr-3">Метки</th>
                <th className="py-2 pr-3">Последний визит</th>
                <th className="py-2 pr-3">Бан</th>
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
                    Подозреваемых не найдено.
                  </td>
                </tr>
              ) : (
                rows.map((suspect) => (
                  <tr key={suspect.id} className="border-t border-neutral-900 align-top">
                    <td className="py-2 pr-3 whitespace-nowrap">
                      <Link
                        href={`/all-players/${suspect.id}`}
                        className="text-sky-400 hover:text-sky-300"
                      >
                        {suspect.canonical_name}
                      </Link>
                      {suspect.role ? (
                        <span className="ml-2 inline-flex items-center gap-1.5 text-xs text-neutral-400">
                          <RoleColorDot color={suspect.role.color} size="sm" />
                          {suspect.role.name}
                        </span>
                      ) : null}
                    </td>
                    <td className="py-2 pr-3">
                      <div className="flex flex-wrap gap-1">
                        {suspect.marks.map((mark) => (
                          <span
                            key={mark.mark_type_id}
                            title={mark.label_ru}
                            className={`inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] font-medium leading-none ${
                              toneClasses[severityTone(mark.severity)]
                            }`}
                          >
                            <span aria-hidden>{markIconEmoji(mark.icon)}</span>
                            <span>{mark.label_ru}</span>
                          </span>
                        ))}
                      </div>
                    </td>
                    <td className="py-2 pr-3 whitespace-nowrap text-neutral-400">
                      {formatDate(suspect.last_seen_at)}
                    </td>
                    <td className="py-2 pr-3 whitespace-nowrap">
                      {suspect.has_active_ban ? (
                        <span className="rounded border border-red-800 bg-red-950/70 px-2 py-0.5 text-xs text-red-200">
                          забанен
                        </span>
                      ) : (
                        <span className="text-xs text-neutral-600">—</span>
                      )}
                    </td>
                  </tr>
                ))
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
