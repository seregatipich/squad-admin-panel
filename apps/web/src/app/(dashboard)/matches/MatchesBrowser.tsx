'use client';

import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Badge,
  type BadgeTone,
  Button,
  Card,
  Checkbox,
  EmptyState,
  FieldRow,
  InlineBanner,
  Modal,
  PageContainer,
  PageHeader,
  Select,
  SkeletonTable,
  SortableTh,
  type SortDirection,
  StatusBadge,
  Table,
  TableBody,
  TableHead,
  TableRow,
  Td,
  TextInput,
  Th,
} from '@/components/ui';
import { useLiveSubscription } from '@/lib/use-live-bus';
import {
  appendMatchPage,
  buildCountApiQuery,
  buildExportUrl,
  buildListApiQuery,
  buildMatchDetailHref,
  buildQueryString,
  clearMatchListScroll,
  DATE_PRESETS,
  formatDateTime,
  formatDuration,
  isOpenMatch,
  liveDurationSeconds,
  type MatchFilters,
  type MatchListItem,
  type MatchListResponse,
  type MatchListScrollSnapshot,
  mergeMatchPage,
  nextSort,
  PAGE_LIMIT,
  type PillTone,
  parseFilters,
  readMatchListScroll,
  type ServerOption,
  SORT_COLUMNS,
  type SortField,
  saveMatchListScroll,
  serverOptionsFromMatches,
  shortServerName,
  shouldDelayMatchScrollRestore,
  teamPillTone,
  winnerLabel,
} from './helpers';

interface ServersResponse {
  items: Array<{ id: string; display_name: string | null; slug: string | null }>;
}

/**
 * Исход команды подкрашивает бейдж с тикетами. Цвет здесь только ускоряет
 * просмотр: кто победил, сказано словами в колонке «Победитель», поэтому строка
 * без подсветки ничего не теряет (дизайн-система, §5).
 */
const TEAM_TONE: Record<PillTone, BadgeTone> = {
  winner: 'good',
  loser: 'crit',
  neutral: 'neutral',
};

/** Как читается направление сортировки колонок списка матчей. */
const SORT_DIRECTION_TEXT: Record<SortDirection, string> = {
  asc: 'по возрастанию',
  desc: 'по убыванию',
};

/*
 * Ссылка на выгрузку остаётся обычным `<a>`, а не `ButtonLink`: `next/link`
 * перехватывает клик и уводит в клиентскую навигацию, из-за чего файл не
 * скачивается. Классы повторяют вторичную кнопку размера `md` (§6).
 */
const DOWNLOAD_LINK_CLASS =
  'inline-flex h-8 items-center justify-center gap-1.5 whitespace-nowrap rounded-ctl border border-line bg-raised px-3 text-xs font-medium text-ink no-underline transition-colors duration-150 hover:bg-line-2';

export function MatchesBrowser() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const filters = useMemo(() => parseFilters(searchParams), [searchParams]);
  const currentListHref = useMemo(() => {
    const query = searchParams.toString();
    return query ? `${pathname}?${query}` : pathname;
  }, [pathname, searchParams]);

  const [items, setItems] = useState<MatchListItem[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [total, setTotal] = useState<number | null>(null);
  const [fetchedServers, setFetchedServers] = useState<ServerOption[]>([]);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [now, setNow] = useState<Date>(() => new Date());
  /**
   * Номер последнего запроса первой страницы. Ответ на отменённый запрос —
   * фильтры сменились, кнопку «Повторить» нажали второй раз, страницу закрыли —
   * не имеет права попасть в состояние поверх актуального.
   */
  const listRequestRef = useRef(0);
  const scrollRestoreRef = useRef<MatchListScrollSnapshot | null>(null);
  const scrollRestoreFrameRef = useRef<number | null>(null);
  const scrollRestoreLoadAttemptsRef = useRef(0);
  const restoredScrollHrefRef = useRef<string | null>(null);

  useEffect(() => {
    scrollRestoreRef.current = readMatchListScroll(window.sessionStorage, currentListHref);
    restoredScrollHrefRef.current = null;
    scrollRestoreLoadAttemptsRef.current = 0;
  }, [currentListHref]);

  useEffect(
    () => () => {
      if (scrollRestoreFrameRef.current !== null) {
        window.cancelAnimationFrame(scrollRestoreFrameRef.current);
      }
    },
    [],
  );

  const navigate = useCallback(
    (partial: Partial<MatchFilters>) => {
      const nextFilters: MatchFilters = { ...filters, ...partial };
      const qs = buildQueryString(nextFilters);
      router.replace(qs ? `${pathname}?${qs}` : pathname);
    },
    [filters, pathname, router],
  );

  const loadFirstPage = useCallback(() => {
    listRequestRef.current += 1;
    const requestId = listRequestRef.current;
    const current = () => listRequestRef.current === requestId;
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
        if (!current()) return;
        setItems(data.items);
        setNextCursor(data.next_cursor);
      })
      .catch((err: unknown) => {
        if (current()) setError((err as Error).message);
      })
      .finally(() => {
        if (current()) setLoading(false);
      });
  }, [filters]);

  useEffect(() => {
    loadFirstPage();
    return () => {
      listRequestRef.current += 1;
    };
  }, [loadFirstPage]);

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

  useEffect(() => {
    if (loading) return;
    const snapshot = scrollRestoreRef.current;
    if (!snapshot || snapshot.href !== currentListHref) return;
    if (restoredScrollHrefRef.current === currentListHref) return;

    const scrollHeight = Math.max(
      document.documentElement.scrollHeight,
      document.body?.scrollHeight ?? 0,
    );
    if (
      shouldDelayMatchScrollRestore(
        snapshot.scrollY,
        window.innerHeight,
        scrollHeight,
        nextCursor !== null,
      ) &&
      !loadingMore &&
      scrollRestoreLoadAttemptsRef.current < 20
    ) {
      scrollRestoreLoadAttemptsRef.current += 1;
      void loadMore();
      return;
    }

    if (scrollRestoreFrameRef.current !== null) {
      window.cancelAnimationFrame(scrollRestoreFrameRef.current);
    }
    scrollRestoreFrameRef.current = window.requestAnimationFrame(() => {
      window.scrollTo(0, snapshot.scrollY);
      clearMatchListScroll(window.sessionStorage, currentListHref);
      scrollRestoreRef.current = null;
      restoredScrollHrefRef.current = currentListHref;
      scrollRestoreFrameRef.current = null;
    });
  }, [currentListHref, loadMore, loading, loadingMore, nextCursor]);

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

  /**
   * Строка списка — настоящая ссылка, поэтому переход делает браузер. Снимок
   * прокрутки успевает сохраниться в обработчике клика: он выполняется до того,
   * как `next/link` начинает навигацию.
   */
  const rememberScroll = useCallback(
    (id: string) => {
      saveMatchListScroll(window.sessionStorage, currentListHref, window.scrollY, id);
    },
    [currentListHref],
  );

  const exportUrl = useMemo(() => buildExportUrl(filters), [filters]);

  const filtersApplied =
    filters.layer.trim() !== '' ||
    filters.servers.length > 0 ||
    filters.hideSeeding ||
    filters.preset !== 'all';

  return (
    <PageContainer>
      <PageHeader
        title="Матчи"
        meta={<span>всего: {total === null ? '…' : total}</span>}
        actions={
          <>
            <a href={exportUrl} className={DOWNLOAD_LINK_CLASS}>
              Экспорт CSV
            </a>
            <Button className="lg:hidden" onClick={() => setDrawerOpen(true)}>
              Фильтры
            </Button>
          </>
        }
      />

      {error ? (
        <InlineBanner
          tone="crit"
          title="Не удалось загрузить список матчей"
          description={error}
          action={
            <Button size="sm" onClick={loadFirstPage}>
              Повторить
            </Button>
          }
        />
      ) : null}

      <div className="flex gap-6">
        <aside className="hidden w-64 shrink-0 lg:block">
          <Card>
            <FilterPanel filters={filters} servers={serverOptions} onChange={navigate} />
          </Card>
        </aside>

        <div className="min-w-0 flex-1 space-y-3">
          <Card padding="none">
            <MatchTable
              items={items}
              loading={loading}
              filters={filters}
              filtersApplied={filtersApplied}
              now={now}
              onSort={(column) => navigate(nextSort(filters, column))}
              onOpen={rememberScroll}
              listHref={currentListHref}
            />
          </Card>

          <div ref={sentinelRef} />

          {nextCursor ? (
            <div className="flex justify-center">
              <Button onClick={() => void loadMore()} loading={loadingMore}>
                Показать ещё
              </Button>
            </div>
          ) : !loading && items.length > 0 ? (
            <p className="py-2 text-center text-xs text-ink-3">Больше матчей нет</p>
          ) : null}
        </div>
      </div>

      <Modal
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        title="Фильтры"
        closeLabel="Закрыть фильтры"
        size="sm"
        footer={
          <Button variant="primary" onClick={() => setDrawerOpen(false)}>
            Готово
          </Button>
        }
      >
        <FilterPanel filters={filters} servers={serverOptions} onChange={navigate} />
      </Modal>
    </PageContainer>
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
    <div className="space-y-4">
      <form
        onSubmit={(event) => {
          event.preventDefault();
          onChange({ layer: layerDraft.trim() });
        }}
      >
        <FieldRow label="Layer">
          <TextInput
            type="search"
            value={layerDraft}
            onChange={(event) => setLayerDraft(event.target.value)}
            onBlur={() => onChange({ layer: layerDraft.trim() })}
            placeholder="Напр. Yehorivka"
          />
        </FieldRow>
      </form>

      <FieldRow label="Период">
        <Select
          value={filters.preset}
          onChange={(event) => onChange({ preset: event.target.value as MatchFilters['preset'] })}
        >
          {DATE_PRESETS.map((preset) => (
            <option key={preset.value} value={preset.value}>
              {preset.label}
            </option>
          ))}
        </Select>
      </FieldRow>

      {filters.preset === 'custom' ? (
        <div className="flex flex-col gap-2">
          <FieldRow label="С">
            <TextInput
              type="date"
              value={filters.from}
              onChange={(event) => onChange({ from: event.target.value })}
            />
          </FieldRow>
          <FieldRow label="По">
            <TextInput
              type="date"
              value={filters.to}
              onChange={(event) => onChange({ to: event.target.value })}
            />
          </FieldRow>
        </div>
      ) : null}

      <div className="space-y-2">
        <p className="text-xs font-medium text-ink-2">Серверы</p>
        {servers.length === 0 ? (
          <p className="text-xs text-ink-3">Нет доступных серверов</p>
        ) : (
          <div className="max-h-48 space-y-1 overflow-y-auto rounded-ctl border border-line p-2">
            {servers.map((server) => (
              <Checkbox
                key={server.id}
                label={server.display_name ?? server.slug ?? server.id.slice(0, 8)}
                checked={filters.servers.includes(server.id)}
                onChange={() => toggleServer(server.id)}
              />
            ))}
          </div>
        )}
      </div>

      <Checkbox
        label="Скрывать seeding"
        checked={filters.hideSeeding}
        onChange={(event) => onChange({ hideSeeding: event.target.checked })}
      />
    </div>
  );
}

function TicketBadge({
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
  return (
    <Badge tone={TEAM_TONE[teamPillTone(team, winner)]}>
      <span className="inline-flex items-center gap-1">
        <span className="truncate">{faction ?? `Команда ${team}`}</span>
        <span className="tabular-nums">{tickets ?? '—'}</span>
      </span>
    </Badge>
  );
}

function MatchTable({
  items,
  loading,
  filters,
  filtersApplied,
  now,
  onSort,
  onOpen,
  listHref,
}: {
  items: MatchListItem[];
  loading: boolean;
  filters: MatchFilters;
  filtersApplied: boolean;
  now: Date;
  onSort: (column: SortField) => void;
  onOpen: (id: string) => void;
  listHref: string;
}) {
  const columnLabel = (column: SortField) =>
    SORT_COLUMNS.find((entry) => entry.value === column)?.label ?? column;

  if (loading && items.length === 0) {
    return (
      <div className="p-3">
        <SkeletonTable rows={8} cols={8} label="Загрузка списка матчей" />
      </div>
    );
  }
  if (!loading && items.length === 0) {
    return (
      <EmptyState
        variant={filtersApplied ? 'filtered' : 'initial'}
        title={filtersApplied ? 'Нет совпадений.' : 'Матчей ещё не было'}
        description={
          filtersApplied
            ? 'Ни один матч не подходит под включённые фильтры.'
            : 'Панель ещё не записала ни одного матча. Запустите сервер и сыграйте раунд.'
        }
      />
    );
  }

  return (
    <Table ariaLabel="Матчи" className="min-w-[820px]">
      <TableHead>
        <tr>
          <Th>Сервер</Th>
          <SortableTh
            sortKey="layer"
            activeKey={filters.sort}
            direction={filters.order}
            onSort={(key) => onSort(key as SortField)}
            label={columnLabel('layer')}
            directionText={SORT_DIRECTION_TEXT}
          />
          <SortableTh
            sortKey="started_at"
            activeKey={filters.sort}
            direction={filters.order}
            onSort={(key) => onSort(key as SortField)}
            label={columnLabel('started_at')}
            directionText={SORT_DIRECTION_TEXT}
          />
          <Th>Конец</Th>
          <Th>Команда 1</Th>
          <Th>Команда 2</Th>
          <SortableTh
            sortKey="duration_seconds"
            activeKey={filters.sort}
            direction={filters.order}
            onSort={(key) => onSort(key as SortField)}
            label={columnLabel('duration_seconds')}
            directionText={SORT_DIRECTION_TEXT}
            align="right"
          />
          <Th>Победитель</Th>
        </tr>
      </TableHead>
      <TableBody>
        {items.map((match) => {
          const open = isOpenMatch(match);
          const duration = open
            ? liveDurationSeconds(match.started_at, now)
            : match.duration_seconds;
          return (
            <TableRow key={match.id} interactive>
              <Td>
                <Link
                  href={buildMatchDetailHref(match.id, listHref)}
                  onClick={() => onOpen(match.id)}
                  title={match.server_name ?? undefined}
                  className="font-medium text-accent no-underline hover:brightness-110"
                >
                  {shortServerName(match)}
                </Link>
              </Td>
              <Td>{match.layer ?? '—'}</Td>
              <Td className="text-xs text-ink-3">{formatDateTime(match.started_at)}</Td>
              <Td className="text-xs text-ink-3">
                {open ? (
                  <StatusBadge state="good" label="Идёт" pulse />
                ) : (
                  formatDateTime(match.ended_at)
                )}
              </Td>
              <Td>
                <TicketBadge
                  team={1}
                  faction={match.team1_faction}
                  tickets={match.team1_tickets}
                  winner={match.winner}
                />
              </Td>
              <Td>
                <TicketBadge
                  team={2}
                  faction={match.team2_faction}
                  tickets={match.team2_tickets}
                  winner={match.winner}
                />
              </Td>
              <Td numeric className="text-xs">
                {formatDuration(duration)}
              </Td>
              <Td className="text-xs">{winnerLabel(match)}</Td>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}
