'use client';

import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Button,
  Card,
  ChevronLeftIcon,
  ChevronRightIcon,
  EmptyState,
  FieldRow,
  IconButton,
  InlineBanner,
  PageContainer,
  PageHeader,
  Pagination,
  type PaginationLabels,
  SearchField,
  Select,
  SkeletonTable,
  SortableTh,
  type SortDirection,
  Table,
  TableBody,
  TableHead,
  TableRow,
  Td,
  Th,
} from '@/components/ui';
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
  sortSeasonsForSelector,
  visibleColumns,
} from './helpers';

interface ServersResponse {
  items: Array<{ id: string; display_name: string | null; slug: string | null }>;
}

interface SeasonsResponse {
  items: Season[];
}

/** Как читается направление сортировки колонок лидерборда. */
const SORT_DIRECTION_TEXT: Record<SortDirection, string> = {
  asc: 'по возрастанию',
  desc: 'по убыванию',
};

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
  /**
   * Номер последнего запроса лидерборда: «Повторить» ходит тем же путём, что и
   * обычная загрузка, а ответ на отменённый запрос в состояние не попадает.
   */
  const requestRef = useRef(0);

  const navigate = useCallback(
    (partial: Partial<LeaderboardFilters>) => {
      const nextFilters: LeaderboardFilters = { ...filters, ...partial };
      const qs = buildQueryString(nextFilters);
      router.replace(qs ? `${pathname}?${qs}` : pathname);
    },
    [filters, pathname, router],
  );

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

  const load = useCallback(() => {
    requestRef.current += 1;
    const requestId = requestRef.current;
    const current = () => requestRef.current === requestId;
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
        if (current()) setData(body);
      })
      .catch((err: unknown) => {
        if (current()) setError((err as Error).message);
      })
      .finally(() => {
        if (current()) setLoading(false);
      });
  }, [filters]);

  useEffect(() => {
    load();
    return () => {
      requestRef.current += 1;
    };
  }, [load]);

  const combatAvailable = data?.combat_available ?? false;
  const economyAvailable = data?.economy_enabled ?? false;
  const columns = useMemo(
    () => visibleColumns(combatAvailable, economyAvailable),
    [combatAvailable, economyAvailable],
  );
  const rows = data?.rows ?? [];
  const totalRows = data?.total_rows ?? 0;
  const totalPages = Math.max(1, data?.total_pages ?? 1);
  const filtersApplied = filters.search !== '' || filters.serverId !== 'all';

  const paginationLabels: PaginationLabels = {
    previous: 'Назад',
    next: 'Вперёд',
    page: (page, of) => pageInfoLabel(page, of, totalRows),
  };

  return (
    <PageContainer>
      <PageHeader title="Лидерборды" meta={<span>всего: {formatCount(totalRows)}</span>} />

      <div className="flex flex-col gap-6 lg:flex-row lg:items-start">
        <FilterRail filters={filters} servers={servers} seasons={seasons} onChange={navigate} />

        <div className="min-w-0 flex-1 space-y-3">
          {error ? (
            <InlineBanner
              tone="crit"
              title="Не удалось загрузить лидерборд"
              description={error}
              action={
                <Button size="sm" onClick={load}>
                  Повторить
                </Button>
              }
            />
          ) : null}

          {!combatAvailable ? (
            <InlineBanner
              tone="warn"
              title="Боевые метрики пока недоступны"
              description="Убийства, смерти, K/D и возрождения появятся после включения импортёра статистики. Пока эти колонки скрыты."
            />
          ) : null}

          <Card padding="none">
            <LeaderboardTable
              columns={columns}
              rows={rows}
              filters={filters}
              filtersApplied={filtersApplied}
              loading={loading}
              onSort={(column) => {
                const sort = nextSort(filters, column);
                if (sort) navigate(sort);
              }}
            />
          </Card>

          <div className="flex justify-end">
            <Pagination
              page={filters.page}
              pageCount={totalPages}
              onChange={(page) => navigate({ page })}
              labels={paginationLabels}
              allowJump
            />
          </div>
        </div>
      </div>
    </PageContainer>
  );
}

function FilterRail({
  filters,
  servers,
  seasons,
  onChange,
}: {
  filters: LeaderboardFilters;
  servers: ServerOption[];
  seasons: Season[];
  onChange: (partial: Partial<LeaderboardFilters>) => void;
}) {
  return (
    <aside className="w-full shrink-0 lg:sticky lg:top-4 lg:w-72">
      <Card className="space-y-4">
        <FieldRow label="Поиск">
          <SearchField
            value={filters.search}
            onCommit={(value) => onChange({ search: value.trim(), page: 1 })}
            label="Поиск по лидерборду"
            placeholder="Ник, SteamID64 или EOS ID…"
            clearLabel="Очистить поиск"
          />
        </FieldRow>

        <FieldRow label="Сервер">
          <Select
            value={filters.serverId}
            onChange={(event) => onChange({ serverId: event.target.value, page: 1 })}
          >
            <option value="all">Все серверы</option>
            {servers.map((server) => (
              <option key={server.id} value={server.id}>
                {server.display_name ?? server.slug ?? server.id.slice(0, 8)}
              </option>
            ))}
          </Select>
        </FieldRow>

        <PeriodPicker filters={filters} seasons={seasons} onChange={onChange} />
      </Card>
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
    <div className="space-y-2">
      <FieldRow label="Период">
        <Select
          value={filters.period}
          onChange={(event) => selectPeriod(event.target.value as Period)}
        >
          {PERIODS.map((period) => (
            <option key={period.value} value={period.value}>
              {period.label}
            </option>
          ))}
        </Select>
      </FieldRow>

      {seasonMode ? (
        orderedSeasons.length === 0 ? (
          <p className="text-xs text-ink-3">Сезоны не заданы.</p>
        ) : (
          <div className="space-y-1">
            <Select
              aria-label="Сезон"
              value={filters.periodStart}
              onChange={(event) => onChange({ periodStart: event.target.value, page: 1 })}
            >
              {orderedSeasons.map((season) => (
                <option key={season.id} value={seasonPeriodStart(season)}>
                  {seasonOptionLabel(season)}
                </option>
              ))}
            </Select>
            {selectedSeason ? (
              <p className="text-xs text-ink-3">
                {seasonRangeLabel(selectedSeason)}
                {isSeasonReadOnly(selectedSeason) ? <span> · только просмотр</span> : null}
              </p>
            ) : null}
          </div>
        )
      ) : null}

      {navigable ? (
        <div className="flex items-center justify-between gap-2">
          <IconButton
            label="Предыдущий период"
            icon={<ChevronLeftIcon />}
            onClick={() =>
              onChange({
                periodStart: shiftPeriodStart(filters.period, filters.periodStart, -1),
                page: 1,
              })
            }
          />
          <span className="min-w-0 flex-1 truncate text-center text-xs text-ink-2">
            {periodRangeLabel(filters.period, filters.periodStart)}
          </span>
          <IconButton
            label="Следующий период"
            icon={<ChevronRightIcon />}
            onClick={() =>
              onChange({
                periodStart: shiftPeriodStart(filters.period, filters.periodStart, 1),
                page: 1,
              })
            }
            disabled={atLatest}
          />
        </div>
      ) : null}
    </div>
  );
}

function LeaderboardTable({
  columns,
  rows,
  filters,
  filtersApplied,
  loading,
  onSort,
}: {
  columns: ReturnType<typeof visibleColumns>;
  rows: LeaderboardRow[];
  filters: LeaderboardFilters;
  filtersApplied: boolean;
  loading: boolean;
  onSort: (column: ColumnKey) => void;
}) {
  if (loading && rows.length === 0) {
    return (
      <div className="p-3">
        <SkeletonTable rows={10} cols={columns.length} label="Загрузка лидерборда" />
      </div>
    );
  }
  if (!loading && rows.length === 0) {
    return (
      <EmptyState
        variant={filtersApplied ? 'filtered' : 'initial'}
        title={filtersApplied ? 'Нет совпадений.' : 'Нет данных за выбранный период.'}
        description={
          filtersApplied
            ? 'Ни один игрок не подходит под запрос и выбранный сервер.'
            : 'За этот период панель не записала ни одного игрока.'
        }
      />
    );
  }

  return (
    <Table ariaLabel="Лидерборд" className="min-w-[720px]">
      <TableHead>
        <tr>
          {columns.map((column) =>
            column.metric ? (
              <SortableTh
                key={column.key}
                sortKey={column.key}
                activeKey={column.metric === filters.metric ? column.key : null}
                direction={filters.order}
                onSort={(key) => onSort(key as ColumnKey)}
                label={column.label}
                directionText={SORT_DIRECTION_TEXT}
                align={column.align === 'left' ? 'left' : 'right'}
              />
            ) : (
              <Th key={column.key} align={column.align === 'left' ? 'left' : 'right'}>
                {column.label}
              </Th>
            ),
          )}
        </tr>
      </TableHead>
      <TableBody>
        {rows.map((row) => {
          const medal = medalFor(row.rank);
          return (
            <TableRow key={row.player_id} interactive>
              {columns.map((column) => (
                <Td
                  key={column.key}
                  align={column.align === 'left' ? 'left' : undefined}
                  numeric={column.align !== 'left'}
                >
                  <CellContent column={column.key} row={row} medal={medal} />
                </Td>
              ))}
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
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
      <span className="text-xs text-ink-3">
        {medal ? (
          <span className="text-base" title={`Место ${row.rank}`}>
            {medal}
          </span>
        ) : (
          row.rank
        )}
      </span>
    );
  }
  if (column === 'player') {
    return (
      <a
        href={`/all-players/${row.player_id}`}
        className="font-medium text-accent no-underline hover:brightness-110"
      >
        {row.current_name}
      </a>
    );
  }
  const metric = column as Metric;
  const value = metricValue(row, metric);
  return <span className="text-xs">{formatMetricValue(metric, value)}</span>;
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
