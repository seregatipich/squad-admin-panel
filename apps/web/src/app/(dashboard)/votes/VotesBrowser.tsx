'use client';

import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { LiveIndicator } from '@/components/LiveIndicator';
import {
  Badge,
  type BadgeTone,
  Button,
  Card,
  Checkbox,
  ChevronDownIcon,
  ChevronUpIcon,
  EmptyState,
  FieldRow,
  InlineBanner,
  Modal,
  PageContainer,
  PageHeader,
  SearchField,
  SegmentedControl,
  Select,
  Skeleton,
  StatusDot,
  TextInput,
} from '@/components/ui';
import { useLiveSubscription } from '@/lib/use-live-bus';
import {
  appendVotePage,
  buildCountApiQuery,
  buildListApiQuery,
  buildQueryString,
  DATE_PRESETS,
  formatDateTime,
  formatDuration,
  mapChain,
  mergeVotePage,
  PAGE_LIMIT,
  parseFilters,
  RESULT_OPTIONS,
  type ResultTone,
  resultLabel,
  resultTone,
  type ServerOption,
  serverOptionsFromVotes,
  shortServerName,
  VOTE_TYPE_OPTIONS,
  type VoteBallot,
  type VoteDetail,
  type VoteFilters,
  type VoteListItem,
  type VoteListResponse,
  voteTypeLabel,
} from './helpers';

interface ServersResponse {
  items: Array<{ id: string; display_name: string | null; slug: string | null }>;
}

/**
 * Исход голосования красит бейдж. Цвет здесь только ускоряет просмотр: сам
 * бейдж называет исход словом, поэтому ничего не теряется (дизайн-система, §5).
 */
const RESULT_BADGE_TONE: Record<ResultTone, BadgeTone> = {
  passed: 'good',
  failed: 'crit',
  cancelled: 'warn',
  pending: 'neutral',
};

const ORDER_ITEMS = [
  { value: 'desc', label: 'Сначала новые' },
  { value: 'asc', label: 'Сначала старые' },
];

export function VotesBrowser() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const filters = useMemo(() => parseFilters(searchParams), [searchParams]);

  const [items, setItems] = useState<VoteListItem[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdate, setLastUpdate] = useState<Date | null>(null);
  const [total, setTotal] = useState<number | null>(null);
  const [fetchedServers, setFetchedServers] = useState<ServerOption[]>([]);
  const [drawerOpen, setDrawerOpen] = useState(false);
  /**
   * Номер последнего запроса первой страницы: «Повторить» ходит тем же путём,
   * что и обычная загрузка, а ответ на отменённый запрос не попадает в список.
   */
  const listRequestRef = useRef(0);

  const navigate = useCallback(
    (partial: Partial<VoteFilters>) => {
      const nextFilters: VoteFilters = { ...filters, ...partial };
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
    fetch(`/api/v1/votes?${buildListApiQuery(filters, { limit: PAGE_LIMIT })}`, {
      credentials: 'include',
      cache: 'no-store',
    })
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return (await res.json()) as VoteListResponse;
      })
      .then((data) => {
        if (!current()) return;
        setItems(data.items);
        setNextCursor(data.next_cursor);
        setLastUpdate(new Date());
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
    fetch(`/api/v1/votes/count?${buildCountApiQuery(filters)}`, {
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

  const loadMore = useCallback(async () => {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const res = await fetch(
        `/api/v1/votes?${buildListApiQuery(filters, { cursor: nextCursor, limit: PAGE_LIMIT })}`,
        { credentials: 'include', cache: 'no-store' },
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as VoteListResponse;
      setItems((prev) => appendVotePage(prev, data.items));
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
    if (filters.order !== 'desc') return;
    fetch(`/api/v1/votes?${buildListApiQuery(filters, { limit: PAGE_LIMIT })}`, {
      credentials: 'include',
      cache: 'no-store',
    })
      .then(async (res) => (res.ok ? ((await res.json()) as VoteListResponse) : null))
      .then((data) => {
        if (!data) return;
        setItems((prev) => mergeVotePage(data.items, prev));
        setLastUpdate(new Date());
      })
      .catch(() => {});
  }, [filters]);
  useLiveSubscription('vote.ended', refreshHead);

  const serverOptions = useMemo(() => {
    const merged = new Map<string, ServerOption>();
    for (const option of fetchedServers) merged.set(option.id, option);
    for (const option of serverOptionsFromVotes(items)) {
      if (!merged.has(option.id)) merged.set(option.id, option);
    }
    return Array.from(merged.values()).sort((left, right) =>
      (left.display_name ?? left.slug ?? '').localeCompare(right.display_name ?? right.slug ?? ''),
    );
  }, [fetchedServers, items]);

  const filtersApplied =
    filters.initiatorQuery.trim() !== '' ||
    filters.voteType !== '' ||
    filters.result !== '' ||
    filters.servers.length > 0 ||
    filters.preset !== 'all';

  return (
    <PageContainer>
      <PageHeader
        title="Голосования"
        status={<LiveIndicator lastUpdate={lastUpdate} />}
        meta={<span>всего: {total === null ? '…' : total}</span>}
        actions={
          <Button className="lg:hidden" onClick={() => setDrawerOpen(true)}>
            Фильтры
          </Button>
        }
      />

      {error ? (
        <InlineBanner
          tone="crit"
          title="Не удалось загрузить голосования"
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
          <VoteCards items={items} loading={loading} filtersApplied={filtersApplied} />

          <div ref={sentinelRef} />

          {nextCursor ? (
            <div className="flex justify-center">
              <Button onClick={() => void loadMore()} loading={loadingMore}>
                Показать ещё
              </Button>
            </div>
          ) : !loading && items.length > 0 ? (
            <p className="py-2 text-center text-xs text-ink-3">Больше голосований нет</p>
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
  filters: VoteFilters;
  servers: ServerOption[];
  onChange: (partial: Partial<VoteFilters>) => void;
}) {
  function toggleServer(id: string) {
    const active = filters.servers.includes(id);
    const nextServers = active
      ? filters.servers.filter((entry) => entry !== id)
      : [...filters.servers, id];
    onChange({ servers: nextServers });
  }

  return (
    <div className="space-y-4">
      <FieldRow label="Инициатор">
        <SearchField
          value={filters.initiatorQuery}
          onCommit={(value) => onChange({ initiatorQuery: value.trim() })}
          label="Поиск по инициатору"
          placeholder="Ник инициатора"
          clearLabel="Очистить поиск по инициатору"
        />
      </FieldRow>

      <FieldRow label="Тип">
        <Select
          value={filters.voteType}
          onChange={(event) =>
            onChange({ voteType: event.target.value as VoteFilters['voteType'] })
          }
        >
          <option value="">Все</option>
          {VOTE_TYPE_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </Select>
      </FieldRow>

      <FieldRow label="Исход">
        <Select
          value={filters.result}
          onChange={(event) => onChange({ result: event.target.value as VoteFilters['result'] })}
        >
          <option value="">Любой</option>
          {RESULT_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </Select>
      </FieldRow>

      <FieldRow label="Период">
        <Select
          value={filters.preset}
          onChange={(event) => onChange({ preset: event.target.value as VoteFilters['preset'] })}
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

      <div className="space-y-1">
        <p className="text-xs font-medium text-ink-2">Сортировка</p>
        <SegmentedControl
          ariaLabel="Сортировка голосований"
          items={ORDER_ITEMS}
          value={filters.order}
          onChange={(value) => onChange({ order: value as VoteFilters['order'] })}
          size="sm"
        />
      </div>

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
    </div>
  );
}

function VoteCards({
  items,
  loading,
  filtersApplied,
}: {
  items: VoteListItem[];
  loading: boolean;
  filtersApplied: boolean;
}) {
  if (loading && items.length === 0) {
    return (
      <Card padding="sm">
        <Skeleton variant="block" count={5} label="Загрузка голосований" />
      </Card>
    );
  }
  if (!loading && items.length === 0) {
    return (
      <Card padding="none">
        <EmptyState
          variant={filtersApplied ? 'filtered' : 'initial'}
          title={filtersApplied ? 'Нет совпадений.' : 'Голосований ещё не было'}
          description={
            filtersApplied
              ? 'Ни одно голосование не подходит под включённые фильтры.'
              : 'Панель ещё не записала ни одного голосования на серверах.'
          }
        />
      </Card>
    );
  }
  return (
    <div className="space-y-3">
      {items.map((vote) => (
        <VoteCard key={vote.id} vote={vote} />
      ))}
    </div>
  );
}

function VoteCard({ vote }: { vote: VoteListItem }) {
  const [expanded, setExpanded] = useState(false);
  const [ballots, setBallots] = useState<VoteBallot[] | null>(null);
  const [ballotsLoading, setBallotsLoading] = useState(false);
  const [ballotsError, setBallotsError] = useState<string | null>(null);

  const tone = resultTone(vote.result);
  const chain = mapChain(vote);

  const loadBallots = useCallback(() => {
    setBallotsLoading(true);
    setBallotsError(null);
    fetch(`/api/v1/votes/${vote.id}`, { credentials: 'include', cache: 'no-store' })
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return (await res.json()) as VoteDetail;
      })
      .then((data) => setBallots(data.ballots))
      .catch((err: unknown) => setBallotsError((err as Error).message))
      .finally(() => setBallotsLoading(false));
  }, [vote.id]);

  const toggle = useCallback(() => {
    const next = !expanded;
    setExpanded(next);
    if (next && ballots === null && !ballotsLoading) loadBallots();
  }, [expanded, ballots, ballotsLoading, loadBallots]);

  return (
    <Card padding="none">
      <div className="flex flex-wrap items-start justify-between gap-3 p-3">
        <div className="min-w-0 space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone="neutral" title={vote.server_name ?? undefined}>
              {shortServerName(vote)}
            </Badge>
            <Badge tone="neutral">{voteTypeLabel(vote.vote_type)}</Badge>
            <span className="text-xs text-ink-3">{formatDateTime(vote.started_at)}</span>
          </div>

          <p className="text-[13px] text-ink-2">
            Инициатор:{' '}
            {vote.initiator_player_id ? (
              <Link
                href={`/all-players/${vote.initiator_player_id}`}
                className="text-accent no-underline hover:brightness-110"
              >
                {vote.initiator_nickname ?? vote.initiator_player_id.slice(0, 8)}
              </Link>
            ) : (
              <span className="text-ink-3">—</span>
            )}
          </p>

          {chain.length > 0 ? (
            <div className="flex flex-wrap items-center gap-1.5 text-xs text-ink-2">
              {chain.map((entry, index) => (
                <span key={`${vote.id}-map-${index}`} className="flex items-center gap-1.5">
                  {index > 0 ? (
                    <span aria-hidden="true" className="text-ink-3">
                      →
                    </span>
                  ) : null}
                  <span className="rounded-ctl bg-raised px-1.5 py-0.5">{entry}</span>
                </span>
              ))}
            </div>
          ) : null}
        </div>

        <div className="flex shrink-0 flex-col items-end gap-1.5 text-right">
          <Badge tone={RESULT_BADGE_TONE[tone]}>{resultLabel(vote.result)}</Badge>
          <span className="text-[13px] tabular-nums text-ink">
            {vote.votes_collected}
            <span className="text-ink-3">/{vote.votes_required}</span>
          </span>
          <span className="text-2xs text-ink-3">{formatDuration(vote.duration_seconds)}</span>
        </div>
      </div>

      <button
        type="button"
        onClick={toggle}
        aria-expanded={expanded}
        className="flex h-8 w-full items-center justify-between border-t border-line px-3 text-xs text-ink-2 transition-colors duration-150 hover:bg-raised/40 hover:text-ink"
      >
        <span>Проголосовавшие ({vote.ballot_count})</span>
        {expanded ? (
          <ChevronUpIcon className="size-3.5" />
        ) : (
          <ChevronDownIcon className="size-3.5" />
        )}
      </button>

      {expanded ? (
        <div className="border-t border-line p-3">
          {ballotsLoading ? (
            <Skeleton variant="text" count={2} label="Загрузка поимённых голосов" />
          ) : ballotsError ? (
            <InlineBanner
              tone="crit"
              title="Не удалось загрузить поимённые голоса"
              description={ballotsError}
              action={
                <Button size="sm" onClick={loadBallots}>
                  Повторить
                </Button>
              }
            />
          ) : ballots && ballots.length > 0 ? (
            <ul className="flex flex-wrap gap-2">
              {ballots.map((ballot) => (
                <li key={`${vote.id}-${ballot.player_id}`}>
                  <Link
                    href={`/all-players/${ballot.player_id}`}
                    className="inline-flex h-7 items-center gap-1.5 rounded-ctl border border-line bg-raised px-2 text-xs text-ink no-underline transition-colors duration-150 hover:bg-line-2"
                  >
                    <span className="truncate">{ballot.nickname}</span>
                    <StatusDot
                      state={ballot.choice === 'yes' ? 'good' : 'crit'}
                      label={ballot.choice === 'yes' ? 'за' : 'против'}
                      size="sm"
                    />
                  </Link>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-xs text-ink-3">Поимённых голосов нет.</p>
          )}
        </div>
      ) : null}
    </Card>
  );
}
