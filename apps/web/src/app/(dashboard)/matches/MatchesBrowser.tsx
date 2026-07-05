'use client';

import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { LiveIndicator } from '@/components/LiveIndicator';
import { useLiveSubscription } from '@/lib/use-live-bus';
import {
  appendMatchPage,
  buildCountApiQuery,
  buildExportUrl,
  buildListApiQuery,
  buildQueryString,
  DATE_PRESETS,
  formatDateTime,
  formatDuration,
  isOpenMatch,
  liveDurationSeconds,
  type MatchFilters,
  type MatchListItem,
  type MatchListResponse,
  mergeMatchPage,
  nextSort,
  PAGE_LIMIT,
  PILL_CLASSES,
  parseFilters,
  type ServerOption,
  SORT_COLUMNS,
  type SortField,
  serverOptionsFromMatches,
  shortServerName,
  teamPillTone,
  winnerLabel,
} from './helpers';

interface ServersResponse {
  items: Array<{ id: string; display_name: string | null; slug: string | null }>;
}

export function MatchesBrowser() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const filters = useMemo(() => parseFilters(searchParams), [searchParams]);

  const [items, setItems] = useState<MatchListItem[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdate, setLastUpdate] = useState<Date | null>(null);
  const [total, setTotal] = useState<number | null>(null);
  const [fetchedServers, setFetchedServers] = useState<ServerOption[]>([]);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [now, setNow] = useState<Date>(() => new Date());

  const navigate = useCallback(
    (partial: Partial<MatchFilters>) => {
      const nextFilters: MatchFilters = { ...filters, ...partial };
      const qs = buildQueryString(nextFilters);
      router.replace(qs ? `${pathname}?${qs}` : pathname);
    },
    [filters, pathname, router],
  );

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetch(`/api/v1/matches?${buildListApiQuery(filters, { limit: PAGE_LIMIT })}`, {
      credentials: 'include',
      cache: 'no-store',
    })
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return (await res.json()) as MatchListResponse;
      })
      .then((data) => {
        if (cancelled) return;
        setItems(data.items);
        setNextCursor(data.next_cursor);
        setLastUpdate(new Date());
      })
      .catch((err: unknown) => {
        if (!cancelled) setError((err as Error).message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [filters]);

  useEffect(() => {
    let cancelled = false;
    setTotal(null);
    fetch(`/api/v1/matches/count?${buildCountApiQuery(filters)}`, {
      credentials: 'include',
      cache: 'no-store',
    })
      .then(async (res) => (res.ok ? ((await res.json()) as { total: number }) : { total: 0 }))
      .then((data) => {
        if (!cancelled) setTotal(data.total);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [filters]);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/v1/servers', { credentials: 'include', cache: 'no-store' })
      .then(async (res) => (res.ok ? ((await res.json()) as ServersResponse) : { items: [] }))
      .then((data) => {
        if (cancelled) return;
        setFetchedServers(
          data.items.map((entry) => ({
            id: entry.id,
            display_name: entry.display_name,
            slug: entry.slug,
          })),
        );
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const hasOpenMatch = useMemo(() => items.some(isOpenMatch), [items]);
  useEffect(() => {
    if (!hasOpenMatch) return;
    const timer = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(timer);
  }, [hasOpenMatch]);

  const loadMore = useCallback(async () => {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const res = await fetch(
        `/api/v1/matches?${buildListApiQuery(filters, { cursor: nextCursor, limit: PAGE_LIMIT })}`,
        { credentials: 'include', cache: 'no-store' },
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as MatchListResponse;
      setItems((prev) => appendMatchPage(prev, data.items));
      setNextCursor(data.next_cursor);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoadingMore(false);
    }
  }, [filters, nextCursor, loadingMore]);

  const sentinelRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const node = sentinelRef.current;
    if (!node || !nextCursor) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) void loadMore();
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [loadMore, nextCursor]);

  const refreshHead = useCallback(() => {
    if (filters.sort !== 'started_at' || filters.order !== 'desc') return;
    fetch(`/api/v1/matches?${buildListApiQuery(filters, { limit: PAGE_LIMIT })}`, {
      credentials: 'include',
      cache: 'no-store',
    })
      .then(async (res) => (res.ok ? ((await res.json()) as MatchListResponse) : null))
      .then((data) => {
        if (!data) return;
        setItems((prev) => mergeMatchPage(data.items, prev));
        setLastUpdate(new Date());
      })
      .catch(() => {});
  }, [filters]);
  useLiveSubscription('match.started', refreshHead);
  useLiveSubscription('match.ended', refreshHead);

  const serverOptions = useMemo(() => {
    const merged = new Map<string, ServerOption>();
    for (const option of fetchedServers) merged.set(option.id, option);
    for (const option of serverOptionsFromMatches(items)) {
      if (!merged.has(option.id)) merged.set(option.id, option);
    }
    return Array.from(merged.values()).sort((left, right) =>
      (left.display_name ?? left.slug ?? '').localeCompare(right.display_name ?? right.slug ?? ''),
    );
  }, [fetchedServers, items]);

  const openRow = useCallback(
    (id: string) => {
      router.push(`/matches/${id}`);
    },
    [router],
  );

  const exportUrl = useMemo(() => buildExportUrl(filters), [filters]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <h1 className="text-2xl font-semibold">Матчи</h1>
          <span className="text-xs text-neutral-500">
            {total === null ? 'Всего: …' : `Всего: ${total}`}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <LiveIndicator lastUpdate={lastUpdate} />
          <a
            href={exportUrl}
            className="rounded border border-neutral-800 px-3 py-1.5 text-sm text-neutral-200 no-underline hover:border-neutral-600"
          >
            Экспорт CSV
          </a>
          <button
            type="button"
            onClick={() => setDrawerOpen(true)}
            className="rounded border border-neutral-800 px-3 py-1.5 text-sm text-neutral-200 hover:border-neutral-600 lg:hidden"
          >
            Фильтры
          </button>
        </div>
      </div>

      {error ? (
        <div className="rounded border border-red-900 bg-red-950 p-3 text-sm text-red-200">
          Ошибка загрузки: {error}
        </div>
      ) : null}

      <div className="flex gap-6">
        <aside className="hidden w-64 shrink-0 lg:block">
          <FilterPanel filters={filters} servers={serverOptions} onChange={navigate} />
        </aside>

        <div className="min-w-0 flex-1 space-y-3">
          <MatchTable
            items={items}
            loading={loading}
            filters={filters}
            now={now}
            onSort={(column) => navigate(nextSort(filters, column))}
            onOpen={openRow}
          />

          <div ref={sentinelRef} />

          {nextCursor ? (
            <div className="flex justify-center">
              <button
                type="button"
                onClick={() => void loadMore()}
                disabled={loadingMore}
                className="rounded border border-neutral-800 px-4 py-1.5 text-sm text-neutral-300 hover:border-neutral-600 disabled:opacity-40"
              >
                {loadingMore ? 'Загрузка…' : 'Показать ещё'}
              </button>
            </div>
          ) : !loading && items.length > 0 ? (
            <div className="py-2 text-center text-xs text-neutral-600">Больше матчей нет</div>
          ) : null}
        </div>
      </div>

      {drawerOpen ? (
        <div className="fixed inset-0 z-40 lg:hidden">
          <button
            type="button"
            aria-label="Закрыть фильтры"
            onClick={() => setDrawerOpen(false)}
            className="absolute inset-0 bg-black/60"
          />
          <div className="absolute inset-y-0 left-0 w-80 max-w-[85%] overflow-y-auto border-r border-neutral-800 bg-neutral-950 p-4">
            <div className="mb-4 flex items-center justify-between">
              <h2 className="text-sm font-semibold text-neutral-200">Фильтры</h2>
              <button
                type="button"
                onClick={() => setDrawerOpen(false)}
                className="rounded border border-neutral-800 px-2 py-0.5 text-sm text-neutral-300 hover:border-neutral-600"
              >
                Готово
              </button>
            </div>
            <FilterPanel filters={filters} servers={serverOptions} onChange={navigate} />
          </div>
        </div>
      ) : null}
    </div>
  );
}

function FilterPanel({
  filters,
  servers,
  onChange,
}: {
  filters: MatchFilters;
  servers: ServerOption[];
  onChange: (partial: Partial<MatchFilters>) => void;
}) {
  const [layerDraft, setLayerDraft] = useState(filters.layer);
  useEffect(() => {
    setLayerDraft(filters.layer);
  }, [filters.layer]);

  function toggleServer(id: string) {
    const active = filters.servers.includes(id);
    const nextServers = active
      ? filters.servers.filter((entry) => entry !== id)
      : [...filters.servers, id];
    onChange({ servers: nextServers });
  }

  return (
    <div className="space-y-5 text-sm">
      <div className="space-y-1.5">
        <span className="text-xs uppercase tracking-widest text-neutral-500">Layer</span>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            onChange({ layer: layerDraft.trim() });
          }}
        >
          <input
            type="search"
            value={layerDraft}
            onChange={(event) => setLayerDraft(event.target.value)}
            onBlur={() => onChange({ layer: layerDraft.trim() })}
            placeholder="Напр. Yehorivka"
            className="w-full rounded border border-neutral-800 bg-neutral-900 px-2 py-1.5 text-sm focus:border-neutral-600 focus:outline-none"
          />
        </form>
      </div>

      <div className="space-y-1.5">
        <span className="text-xs uppercase tracking-widest text-neutral-500">Период</span>
        <div className="flex flex-wrap gap-1">
          {DATE_PRESETS.map((preset) => (
            <button
              key={preset.value}
              type="button"
              onClick={() => onChange({ preset: preset.value })}
              className={`rounded px-2 py-0.5 text-xs ${
                filters.preset === preset.value
                  ? 'bg-neutral-800 text-neutral-100'
                  : 'text-neutral-400 hover:text-neutral-200'
              }`}
            >
              {preset.label}
            </button>
          ))}
        </div>
        {filters.preset === 'custom' ? (
          <div className="flex flex-col gap-2 pt-1">
            <label className="flex items-center justify-between gap-2 text-xs text-neutral-500">
              С
              <input
                type="date"
                value={filters.from}
                onChange={(event) => onChange({ from: event.target.value })}
                className="rounded border border-neutral-800 bg-neutral-900 px-2 py-1 text-xs text-neutral-200 focus:border-neutral-600 focus:outline-none"
              />
            </label>
            <label className="flex items-center justify-between gap-2 text-xs text-neutral-500">
              По
              <input
                type="date"
                value={filters.to}
                onChange={(event) => onChange({ to: event.target.value })}
                className="rounded border border-neutral-800 bg-neutral-900 px-2 py-1 text-xs text-neutral-200 focus:border-neutral-600 focus:outline-none"
              />
            </label>
          </div>
        ) : null}
      </div>

      <div className="space-y-1.5">
        <span className="text-xs uppercase tracking-widest text-neutral-500">Серверы</span>
        {servers.length === 0 ? (
          <p className="text-xs text-neutral-600">Нет доступных серверов</p>
        ) : (
          <div className="max-h-48 space-y-1 overflow-y-auto rounded border border-neutral-900 p-1">
            {servers.map((server) => {
              const active = filters.servers.includes(server.id);
              return (
                <label
                  key={server.id}
                  className="flex cursor-pointer items-center gap-2 rounded px-1.5 py-1 text-xs text-neutral-300 hover:bg-neutral-900"
                >
                  <input
                    type="checkbox"
                    checked={active}
                    onChange={() => toggleServer(server.id)}
                    className="accent-sky-500"
                  />
                  <span className="truncate">
                    {server.display_name ?? server.slug ?? server.id.slice(0, 8)}
                  </span>
                </label>
              );
            })}
          </div>
        )}
      </div>

      <label className="flex items-center gap-2 text-xs text-neutral-300">
        <input
          type="checkbox"
          checked={filters.hideSeeding}
          onChange={(event) => onChange({ hideSeeding: event.target.checked })}
          className="accent-sky-500"
        />
        Скрывать seeding
      </label>
    </div>
  );
}

function SortHeader({
  column,
  label,
  filters,
  onSort,
}: {
  column: SortField;
  label: string;
  filters: MatchFilters;
  onSort: (column: SortField) => void;
}) {
  const active = filters.sort === column;
  const arrow = active ? (filters.order === 'desc' ? '↓' : '↑') : '';
  return (
    <button
      type="button"
      onClick={() => onSort(column)}
      className={`inline-flex items-center gap-1 ${active ? 'text-neutral-200' : 'hover:text-neutral-300'}`}
    >
      {label}
      <span className="w-2 text-[10px]">{arrow}</span>
    </button>
  );
}

function TicketPill({
  team,
  faction,
  tickets,
  winner,
}: {
  team: 1 | 2;
  faction: string | null;
  tickets: number | null;
  winner: MatchListItem['winner'];
}) {
  const tone = teamPillTone(team, winner);
  return (
    <span
      className={`inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-xs ${PILL_CLASSES[tone]}`}
    >
      <span className="truncate">{faction ?? `Команда ${team}`}</span>
      <span className="font-mono">{tickets ?? '—'}</span>
    </span>
  );
}

function MatchTable({
  items,
  loading,
  filters,
  now,
  onSort,
  onOpen,
}: {
  items: MatchListItem[];
  loading: boolean;
  filters: MatchFilters;
  now: Date;
  onSort: (column: SortField) => void;
  onOpen: (id: string) => void;
}) {
  const columnLabel = (column: SortField) =>
    SORT_COLUMNS.find((entry) => entry.value === column)?.label ?? column;

  if (loading && items.length === 0) {
    return <div className="py-10 text-center text-sm text-neutral-500">Загрузка…</div>;
  }
  if (!loading && items.length === 0) {
    return (
      <div className="rounded border border-dashed border-neutral-800 py-12 text-center text-sm text-neutral-400">
        Матчи не найдены. Измените фильтры.
      </div>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[820px] text-sm">
        <thead className="text-left text-xs uppercase text-neutral-500">
          <tr className="border-b border-neutral-900">
            <th className="py-2 pr-3">Сервер</th>
            <th className="py-2 pr-3">
              <SortHeader
                column="layer"
                label={columnLabel('layer')}
                filters={filters}
                onSort={onSort}
              />
            </th>
            <th className="py-2 pr-3">
              <SortHeader
                column="started_at"
                label={columnLabel('started_at')}
                filters={filters}
                onSort={onSort}
              />
            </th>
            <th className="py-2 pr-3">Конец</th>
            <th className="py-2 pr-3">Команда 1</th>
            <th className="py-2 pr-3">Команда 2</th>
            <th className="py-2 pr-3">
              <SortHeader
                column="duration_seconds"
                label={columnLabel('duration_seconds')}
                filters={filters}
                onSort={onSort}
              />
            </th>
            <th className="py-2 pr-3">Победитель</th>
          </tr>
        </thead>
        <tbody>
          {items.map((match) => {
            const open = isOpenMatch(match);
            const duration = open
              ? liveDurationSeconds(match.started_at, now)
              : match.duration_seconds;
            return (
              <tr
                key={match.id}
                onClick={() => onOpen(match.id)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') onOpen(match.id);
                }}
                tabIndex={0}
                className="cursor-pointer border-b border-neutral-900 align-middle hover:bg-neutral-900/40 focus:bg-neutral-900/40 focus:outline-none"
              >
                <td className="py-2 pr-3">
                  <span
                    title={match.server_name ?? undefined}
                    className="inline-block rounded bg-neutral-800 px-1.5 py-0.5 text-xs text-neutral-200"
                  >
                    {shortServerName(match)}
                  </span>
                </td>
                <td className="py-2 pr-3 text-neutral-200">{match.layer ?? '—'}</td>
                <td className="py-2 pr-3 text-xs text-neutral-400">
                  {formatDateTime(match.started_at)}
                </td>
                <td className="py-2 pr-3 text-xs text-neutral-400">
                  {open ? (
                    <span className="inline-flex items-center gap-1 rounded border border-emerald-800 bg-emerald-950/60 px-1.5 py-0.5 text-[11px] text-emerald-300">
                      <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-400" />
                      Идёт
                    </span>
                  ) : (
                    formatDateTime(match.ended_at)
                  )}
                </td>
                <td className="py-2 pr-3">
                  <TicketPill
                    team={1}
                    faction={match.team1_faction}
                    tickets={match.team1_tickets}
                    winner={match.winner}
                  />
                </td>
                <td className="py-2 pr-3">
                  <TicketPill
                    team={2}
                    faction={match.team2_faction}
                    tickets={match.team2_tickets}
                    winner={match.winner}
                  />
                </td>
                <td className="py-2 pr-3 font-mono text-xs text-neutral-300">
                  {formatDuration(duration)}
                </td>
                <td className="py-2 pr-3 text-xs text-neutral-300">{winnerLabel(match)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
