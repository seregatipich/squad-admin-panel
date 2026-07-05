'use client';

import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { LiveIndicator } from '@/components/LiveIndicator';
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
  RESULT_TONE_CLASSES,
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

  const navigate = useCallback(
    (partial: Partial<VoteFilters>) => {
      const nextFilters: VoteFilters = { ...filters, ...partial };
      const qs = buildQueryString(nextFilters);
      router.replace(qs ? `${pathname}?${qs}` : pathname);
    },
    [filters, pathname, router],
  );

  useEffect(() => {
    let cancelled = false;
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

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <h1 className="text-2xl font-semibold">Голосования</h1>
          <span className="text-xs text-neutral-500">
            {total === null ? 'Всего: …' : `Всего: ${total}`}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <LiveIndicator lastUpdate={lastUpdate} />
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
          <VoteCards items={items} loading={loading} />

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
            <div className="py-2 text-center text-xs text-neutral-600">Больше голосований нет</div>
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
  filters: VoteFilters;
  servers: ServerOption[];
  onChange: (partial: Partial<VoteFilters>) => void;
}) {
  const [initiatorDraft, setInitiatorDraft] = useState(filters.initiatorQuery);
  useEffect(() => {
    setInitiatorDraft(filters.initiatorQuery);
  }, [filters.initiatorQuery]);

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
        <span className="text-xs uppercase tracking-widest text-neutral-500">Инициатор</span>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            onChange({ initiatorQuery: initiatorDraft.trim() });
          }}
        >
          <input
            type="search"
            value={initiatorDraft}
            onChange={(event) => setInitiatorDraft(event.target.value)}
            onBlur={() => onChange({ initiatorQuery: initiatorDraft.trim() })}
            placeholder="Ник инициатора"
            className="w-full rounded border border-neutral-800 bg-neutral-900 px-2 py-1.5 text-sm focus:border-neutral-600 focus:outline-none"
          />
        </form>
      </div>

      <div className="space-y-1.5">
        <span className="text-xs uppercase tracking-widest text-neutral-500">Тип</span>
        <div className="flex flex-wrap gap-1">
          <FilterPill
            label="Все"
            active={filters.voteType === ''}
            onClick={() => onChange({ voteType: '' })}
          />
          {VOTE_TYPE_OPTIONS.map((option) => (
            <FilterPill
              key={option.value}
              label={option.label}
              active={filters.voteType === option.value}
              onClick={() => onChange({ voteType: option.value })}
            />
          ))}
        </div>
      </div>

      <div className="space-y-1.5">
        <span className="text-xs uppercase tracking-widest text-neutral-500">Исход</span>
        <div className="flex flex-wrap gap-1">
          <FilterPill
            label="Любой"
            active={filters.result === ''}
            onClick={() => onChange({ result: '' })}
          />
          {RESULT_OPTIONS.map((option) => (
            <FilterPill
              key={option.value}
              label={option.label}
              active={filters.result === option.value}
              onClick={() => onChange({ result: option.value })}
            />
          ))}
        </div>
      </div>

      <div className="space-y-1.5">
        <span className="text-xs uppercase tracking-widest text-neutral-500">Период</span>
        <div className="flex flex-wrap gap-1">
          {DATE_PRESETS.map((preset) => (
            <FilterPill
              key={preset.value}
              label={preset.label}
              active={filters.preset === preset.value}
              onClick={() => onChange({ preset: preset.value })}
            />
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
        <span className="text-xs uppercase tracking-widest text-neutral-500">Сортировка</span>
        <div className="flex flex-wrap gap-1">
          <FilterPill
            label="Сначала новые"
            active={filters.order === 'desc'}
            onClick={() => onChange({ order: 'desc' })}
          />
          <FilterPill
            label="Сначала старые"
            active={filters.order === 'asc'}
            onClick={() => onChange({ order: 'asc' })}
          />
        </div>
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
    </div>
  );
}

function FilterPill({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded px-2 py-0.5 text-xs ${
        active ? 'bg-neutral-800 text-neutral-100' : 'text-neutral-400 hover:text-neutral-200'
      }`}
    >
      {label}
    </button>
  );
}

function VoteCards({ items, loading }: { items: VoteListItem[]; loading: boolean }) {
  if (loading && items.length === 0) {
    return <div className="py-10 text-center text-sm text-neutral-500">Загрузка…</div>;
  }
  if (!loading && items.length === 0) {
    return (
      <div className="rounded border border-dashed border-neutral-800 py-12 text-center text-sm text-neutral-400">
        Голосования не найдены. Измените фильтры.
      </div>
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

  const toggle = useCallback(() => {
    const next = !expanded;
    setExpanded(next);
    if (next && ballots === null && !ballotsLoading) {
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
    }
  }, [expanded, ballots, ballotsLoading, vote.id]);

  return (
    <div className="rounded-lg border border-neutral-800 bg-neutral-950/40">
      <div className="flex flex-wrap items-start justify-between gap-3 p-3">
        <div className="min-w-0 space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <span
              title={vote.server_name ?? undefined}
              className="inline-block rounded bg-neutral-800 px-1.5 py-0.5 text-xs text-neutral-200"
            >
              {shortServerName(vote)}
            </span>
            <span className="rounded border border-neutral-800 bg-neutral-900 px-1.5 py-0.5 text-xs text-neutral-300">
              {voteTypeLabel(vote.vote_type)}
            </span>
            <span className="text-xs text-neutral-500">{formatDateTime(vote.started_at)}</span>
          </div>

          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
            <span className="text-neutral-400">
              Инициатор:{' '}
              {vote.initiator_player_id ? (
                <Link
                  href={`/players/${vote.initiator_player_id}`}
                  className="text-sky-300 hover:text-sky-200"
                >
                  {vote.initiator_nickname ?? vote.initiator_player_id.slice(0, 8)}
                </Link>
              ) : (
                <span className="text-neutral-500">—</span>
              )}
            </span>
          </div>

          {chain.length > 0 ? (
            <div className="flex flex-wrap items-center gap-1.5 font-mono text-xs text-neutral-300">
              {chain.map((entry, index) => (
                <span key={`${vote.id}-map-${index}`} className="flex items-center gap-1.5">
                  {index > 0 ? <span className="text-neutral-600">→</span> : null}
                  <span className="rounded bg-neutral-900 px-1.5 py-0.5">{entry}</span>
                </span>
              ))}
            </div>
          ) : null}
        </div>

        <div className="flex shrink-0 flex-col items-end gap-1.5 text-right">
          <span
            className={`inline-flex items-center rounded border px-2 py-0.5 text-xs ${RESULT_TONE_CLASSES[tone]}`}
          >
            {resultLabel(vote.result)}
          </span>
          <span className="font-mono text-sm text-neutral-200">
            {vote.votes_collected}
            <span className="text-neutral-500">/{vote.votes_required}</span>
          </span>
          <span className="text-[11px] text-neutral-500">
            {formatDuration(vote.duration_seconds)}
          </span>
        </div>
      </div>

      <button
        type="button"
        onClick={toggle}
        aria-expanded={expanded}
        className="flex w-full items-center justify-between border-t border-neutral-900 px-3 py-1.5 text-xs text-neutral-400 hover:bg-neutral-900/40 hover:text-neutral-200"
      >
        <span>Проголосовавшие ({vote.ballot_count})</span>
        <span aria-hidden>{expanded ? '▲' : '▼'}</span>
      </button>

      {expanded ? (
        <div className="border-t border-neutral-900 p-3">
          {ballotsLoading ? (
            <div className="text-xs text-neutral-500">Загрузка…</div>
          ) : ballotsError ? (
            <div className="text-xs text-red-300">Ошибка: {ballotsError}</div>
          ) : ballots && ballots.length > 0 ? (
            <ul className="flex flex-wrap gap-2">
              {ballots.map((ballot) => (
                <li key={`${vote.id}-${ballot.player_id}`}>
                  <Link
                    href={`/players/${ballot.player_id}`}
                    className="inline-flex items-center gap-1.5 rounded border border-neutral-800 bg-neutral-900 px-2 py-1 text-xs text-neutral-200 no-underline hover:border-neutral-600"
                  >
                    <span
                      aria-hidden
                      className={`h-1.5 w-1.5 rounded-full ${
                        ballot.choice === 'yes' ? 'bg-emerald-400' : 'bg-red-400'
                      }`}
                    />
                    <span className="truncate">{ballot.nickname}</span>
                    <span className="text-neutral-500">
                      {ballot.choice === 'yes' ? 'за' : 'против'}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          ) : (
            <div className="text-xs text-neutral-500">Поимённых голосов нет.</div>
          )}
        </div>
      ) : null}
    </div>
  );
}
