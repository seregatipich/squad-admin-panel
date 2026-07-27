'use client';

import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  buildApiQuery,
  buildQueryString,
  type ColumnKey,
  canNavigatePeriod,
  currentPeriodStart,
  defaultSeasonPeriodStart,
  findSeason,
  formatCount,
  formatMetricValue,
  isFuturePeriod,
  isSeasonReadOnly,
  type LeaderboardBody,
  type LeaderboardFilters,
  type LeaderboardRow,
  type Metric,
  medalFor,
  nextSort,
  PERIODS,
  type Period,
  pageInfoLabel,
  parseFilters,
  periodRangeLabel,
  type Season,
  type ServerOption,
  seasonOptionLabel,
  seasonPeriodStart,
  seasonRangeLabel,
  shiftPeriodStart,
  shouldNavigateRow,
  sortSeasonsForSelector,
  visibleColumns,
} from './helpers';

interface ServersResponse {
  items: Array<{ id: string; display_name: string | null; slug: string | null }>;
}

interface SeasonsResponse {
  items: Season[];
}

const inputClass =
  'rounded border border-neutral-800 bg-neutral-950 px-3 py-1.5 text-sm text-neutral-100 focus:border-neutral-600 focus:outline-none';

export function LeaderboardsBrowser() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const filters = useMemo(() => parseFilters(searchParams), [searchParams]);

  const [servers, setServers] = useState<ServerOption[]>([]);
  const [seasons, setSeasons] = useState<Season[]>([]);
  const [data, setData] = useState<LeaderboardBody | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [searchDraft, setSearchDraft] = useState(filters.search);

  const navigate = useCallback(
    (partial: Partial<LeaderboardFilters>) => {
      const nextFilters: LeaderboardFilters = { ...filters, ...partial };
      const qs = buildQueryString(nextFilters);
      router.replace(qs ? `${pathname}?${qs}` : pathname);
    },
    [filters, pathname, router],
  );

  useEffect(() => {
    setSearchDraft(filters.search);
  }, [filters.search]);

  useEffect(() => {
    const trimmed = searchDraft.trim();
    if (trimmed === filters.search) return;
    const timer = setTimeout(() => navigate({ search: trimmed, page: 1 }), 300);
    return () => clearTimeout(timer);
  }, [searchDraft, filters.search, navigate]);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/v1/servers', { credentials: 'include', cache: 'no-store' })
      .then(async (res) => (res.ok ? ((await res.json()) as ServersResponse) : { items: [] }))
      .then((body) => {
        if (cancelled) return;
        setServers(
          body.items.map((entry) => ({
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

  // LEAD-7 (#178): the season list drives the period selector. A viewer without
  // panel access simply gets no seasons, which collapses the selector rather
  // than surfacing an error — the leaderboard itself already reports auth.
  useEffect(() => {
    let cancelled = false;
    fetch('/api/v1/seasons', { credentials: 'include', cache: 'no-store' })
      .then(async (res) => (res.ok ? ((await res.json()) as SeasonsResponse) : { items: [] }))
      .then((body) => {
        if (!cancelled) setSeasons(body.items);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetch(`/api/v1/leaderboards?${buildApiQuery(filters)}`, {
      credentials: 'include',
      cache: 'no-store',
    })
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return (await res.json()) as LeaderboardBody;
      })
      .then((body) => {
        if (cancelled) return;
        setData(body);
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

  const combatAvailable = data?.combat_available ?? false;
  const economyAvailable = data?.economy_enabled ?? false;
  const columns = useMemo(
    () => visibleColumns(combatAvailable, economyAvailable),
    [combatAvailable, economyAvailable],
  );
  const rows = data?.rows ?? [];
  const totalRows = data?.total_rows ?? 0;
  const totalPages = Math.max(1, data?.total_pages ?? 1);

  const openPlayer = useCallback(
    (playerId: string, event: React.MouseEvent) => {
      const target = event.target as HTMLElement;
      if (target.closest('a')) return;
      const selection = typeof window !== 'undefined' ? window.getSelection()?.toString() : '';
      const allowed = shouldNavigateRow({
        ctrlKey: event.ctrlKey,
        metaKey: event.metaKey,
        altKey: event.altKey,
        shiftKey: event.shiftKey,
        hasSelection: Boolean(selection),
      });
      if (!allowed) return;
      router.push(`/players/${playerId}`);
    },
    [router],
  );

  return (
    <div className="flex flex-col gap-4 lg:flex-row lg:items-start">
      <FilterRail
        filters={filters}
        servers={servers}
        seasons={seasons}
        searchDraft={searchDraft}
        onSearchChange={setSearchDraft}
        onChange={navigate}
      />

      <div className="min-w-0 flex-1 space-y-3">
        <div className="flex items-center justify-between gap-3">
          <h1 className="text-2xl font-semibold">Лидерборды</h1>
          <span className="text-xs text-neutral-500">Всего: {formatCount(totalRows)}</span>
        </div>

        {error ? (
          <div className="rounded border border-red-900 bg-red-950 p-3 text-sm text-red-200">
            Ошибка загрузки: {error}
          </div>
        ) : null}

        {!combatAvailable ? (
          <div className="rounded border border-amber-900/60 bg-amber-950/30 p-3 text-xs text-amber-300">
            Боевые метрики (убийства, смерти, K/D, возрождения) появятся после включения импортёра
            статистики. Пока эти колонки скрыты.
          </div>
        ) : null}

        <LeaderboardTable
          columns={columns}
          rows={rows}
          filters={filters}
          loading={loading}
          onSort={(column) => {
            const sort = nextSort(filters, column);
            if (sort) navigate(sort);
          }}
          onOpenPlayer={openPlayer}
        />

        <div className="flex flex-wrap items-center justify-between gap-3 text-xs text-neutral-400">
          <span>{pageInfoLabel(filters.page, totalPages, totalRows)}</span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => navigate({ page: Math.max(1, filters.page - 1) })}
              disabled={filters.page <= 1 || loading}
              className="rounded border border-neutral-800 px-3 py-1 hover:border-neutral-600 disabled:opacity-40"
            >
              Назад
            </button>
            <button
              type="button"
              onClick={() => navigate({ page: Math.min(totalPages, filters.page + 1) })}
              disabled={filters.page >= totalPages || loading}
              className="rounded border border-neutral-800 px-3 py-1 hover:border-neutral-600 disabled:opacity-40"
            >
              Вперёд
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function FilterRail({
  filters,
  servers,
  seasons,
  searchDraft,
  onSearchChange,
  onChange,
}: {
  filters: LeaderboardFilters;
  servers: ServerOption[];
  seasons: Season[];
  searchDraft: string;
  onSearchChange: (value: string) => void;
  onChange: (partial: Partial<LeaderboardFilters>) => void;
}) {
  return (
    <aside className="w-full shrink-0 space-y-5 rounded border border-neutral-800 bg-neutral-950/40 p-4 lg:sticky lg:top-4 lg:w-72">
      <div className="space-y-1.5">
        <span className="text-xs uppercase tracking-widest text-neutral-500">Поиск</span>
        <input
          type="search"
          value={searchDraft}
          onChange={(event) => onSearchChange(event.target.value)}
          placeholder="Ник, SteamID64 или EOS ID…"
          className={`w-full ${inputClass}`}
        />
      </div>

      <div className="space-y-1.5">
        <span className="text-xs uppercase tracking-widest text-neutral-500">Сервер</span>
        <select
          value={filters.serverId}
          onChange={(event) => onChange({ serverId: event.target.value, page: 1 })}
          className={`w-full ${inputClass}`}
        >
          <option value="all">Все серверы</option>
          {servers.map((server) => (
            <option key={server.id} value={server.id}>
              {server.display_name ?? server.slug ?? server.id.slice(0, 8)}
            </option>
          ))}
        </select>
      </div>

      <PeriodPicker filters={filters} seasons={seasons} onChange={onChange} />
    </aside>
  );
}

function PeriodPicker({
  filters,
  seasons,
  onChange,
}: {
  filters: LeaderboardFilters;
  seasons: Season[];
  onChange: (partial: Partial<LeaderboardFilters>) => void;
}) {
  const navigable = canNavigatePeriod(filters.period);
  const atLatest = isFuturePeriod(filters.period, filters.periodStart);
  const seasonMode = filters.period === 'season';
  const orderedSeasons = useMemo(() => sortSeasonsForSelector(seasons), [seasons]);
  const selectedSeason = seasonMode ? findSeason(seasons, filters.periodStart) : null;

  function selectPeriod(period: Period) {
    if (period === 'season') {
      onChange({ period, periodStart: defaultSeasonPeriodStart(seasons), page: 1 });
      return;
    }
    onChange({
      period,
      periodStart: canNavigatePeriod(period) ? currentPeriodStart(period) : '',
      page: 1,
    });
  }

  return (
    <div className="space-y-1.5">
      <span className="text-xs uppercase tracking-widest text-neutral-500">Период</span>
      <div className="flex flex-wrap gap-1">
        {PERIODS.map((period) => (
          <button
            key={period.value}
            type="button"
            onClick={() => selectPeriod(period.value)}
            className={`rounded px-2 py-1 text-xs ${
              filters.period === period.value
                ? 'bg-neutral-800 text-neutral-100'
                : 'text-neutral-400 hover:text-neutral-200'
            }`}
          >
            {period.label}
          </button>
        ))}
      </div>
      {seasonMode ? (
        <div className="space-y-1.5 pt-1">
          {orderedSeasons.length === 0 ? (
            <p className="text-xs text-neutral-500">Сезоны не заданы.</p>
          ) : (
            <>
              <select
                aria-label="Сезон"
                value={filters.periodStart}
                onChange={(event) => onChange({ periodStart: event.target.value, page: 1 })}
                className={`w-full ${inputClass}`}
              >
                {orderedSeasons.map((season) => (
                  <option key={season.id} value={seasonPeriodStart(season)}>
                    {seasonOptionLabel(season)}
                  </option>
                ))}
              </select>
              {selectedSeason ? (
                <p className="text-xs text-neutral-400">
                  {seasonRangeLabel(selectedSeason)}
                  {isSeasonReadOnly(selectedSeason) ? (
                    <span className="ml-1 text-neutral-500">· только просмотр</span>
                  ) : null}
                </p>
              ) : null}
            </>
          )}
        </div>
      ) : null}
      {navigable ? (
        <div className="flex items-center justify-between gap-2 pt-1">
          <button
            type="button"
            aria-label="Предыдущий период"
            onClick={() =>
              onChange({
                periodStart: shiftPeriodStart(filters.period, filters.periodStart, -1),
                page: 1,
              })
            }
            className="rounded border border-neutral-800 px-2 py-1 text-sm hover:border-neutral-600"
          >
            ‹
          </button>
          <span className="min-w-0 flex-1 truncate text-center text-xs text-neutral-300">
            {periodRangeLabel(filters.period, filters.periodStart)}
          </span>
          <button
            type="button"
            aria-label="Следующий период"
            onClick={() =>
              onChange({
                periodStart: shiftPeriodStart(filters.period, filters.periodStart, 1),
                page: 1,
              })
            }
            disabled={atLatest}
            className="rounded border border-neutral-800 px-2 py-1 text-sm hover:border-neutral-600 disabled:opacity-40"
          >
            ›
          </button>
        </div>
      ) : null}
    </div>
  );
}

function LeaderboardTable({
  columns,
  rows,
  filters,
  loading,
  onSort,
  onOpenPlayer,
}: {
  columns: ReturnType<typeof visibleColumns>;
  rows: LeaderboardRow[];
  filters: LeaderboardFilters;
  loading: boolean;
  onSort: (column: ColumnKey) => void;
  onOpenPlayer: (playerId: string, event: React.MouseEvent) => void;
}) {
  if (loading && rows.length === 0) {
    return <div className="py-10 text-center text-sm text-neutral-500">Загрузка…</div>;
  }
  if (!loading && rows.length === 0) {
    return (
      <div className="rounded border border-dashed border-neutral-800 py-12 text-center text-sm text-neutral-400">
        Нет данных за выбранный период.
      </div>
    );
  }

  return (
    <div className="overflow-x-auto rounded border border-neutral-800">
      <table className="w-full min-w-[720px] text-sm">
        <thead className="bg-neutral-950 text-xs uppercase tracking-wider text-neutral-500">
          <tr>
            {columns.map((column) => {
              const active = column.metric === filters.metric;
              const arrow = active ? (filters.order === 'desc' ? '↓' : '↑') : '';
              return (
                <th
                  key={column.key}
                  title={column.tooltip}
                  className={`p-2 ${column.align === 'left' ? 'text-left' : 'text-right'} ${
                    active ? 'text-sky-300' : ''
                  }`}
                >
                  {column.metric ? (
                    <button
                      type="button"
                      onClick={() => onSort(column.key)}
                      className={`inline-flex items-center gap-1 ${
                        active ? 'text-sky-300' : 'hover:text-neutral-300'
                      }`}
                    >
                      {column.label}
                      <span className="w-2 text-[10px]">{arrow}</span>
                    </button>
                  ) : (
                    column.label
                  )}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const medal = medalFor(row.rank);
            return (
              <tr
                key={row.player_id}
                onClick={(event) => onOpenPlayer(row.player_id, event)}
                className="cursor-pointer border-t border-neutral-900 hover:bg-neutral-900/40"
              >
                {columns.map((column) => (
                  <td
                    key={column.key}
                    className={`p-2 ${column.align === 'left' ? 'text-left' : 'text-right'} ${
                      column.metric === filters.metric ? 'text-sky-200' : ''
                    }`}
                  >
                    <CellContent column={column.key} row={row} medal={medal} />
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function CellContent({
  column,
  row,
  medal,
}: {
  column: ColumnKey;
  row: LeaderboardRow;
  medal: string | null;
}) {
  if (column === 'rank') {
    return (
      <span className="font-mono text-xs text-neutral-400">
        {medal ? <span className="text-base">{medal}</span> : row.rank}
      </span>
    );
  }
  if (column === 'player') {
    return (
      <a
        href={`/players/${row.player_id}`}
        className="font-medium text-sky-400 hover:text-sky-300"
        onClick={(event) => event.stopPropagation()}
      >
        {row.current_name}
      </a>
    );
  }
  const metric = column as Metric;
  const value = metricValue(row, metric);
  return <span className="font-mono text-xs">{formatMetricValue(metric, value)}</span>;
}

function metricValue(row: LeaderboardRow, metric: Metric): number {
  switch (metric) {
    case 'online':
      return row.secondary.online_seconds;
    case 'seeding':
      return row.secondary.seeding_seconds;
    case 'kills':
      return row.secondary.kills;
    case 'deaths':
      return row.secondary.deaths;
    case 'kd':
      return row.secondary.kd;
    case 'bonus':
      return row.secondary.bonus_points ?? row.metric_value;
    case 'boost':
      return row.secondary.boost_seconds ?? row.metric_value;
    default:
      return row.metric_value;
  }
}
