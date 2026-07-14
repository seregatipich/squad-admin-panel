'use client';

import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  appendEventPage,
  buildCountApiQuery,
  buildExportApiQuery,
  buildListApiQuery,
  buildQueryString,
  DATE_PRESETS,
  type EventEnvelope,
  type EventFilters,
  type EventListItem,
  type EventListResponse,
  formatDateTime,
  kindLabel,
  kindOptionsFromEvents,
  kindTone,
  PAGE_LIMIT,
  parseFilters,
  type ServerOption,
  serverOptionsFromEvents,
  shortServerName,
} from './helpers';

interface ServersResponse {
  items: Array<{ id: string; display_name: string | null; slug: string | null }>;
}

export function EventsBrowser({ lockedServerId }: { lockedServerId?: string }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const filters = useMemo(() => parseFilters(searchParams), [searchParams]);

  const [items, setItems] = useState<EventListItem[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [total, setTotal] = useState<number | null>(null);
  const [fetchedServers, setFetchedServers] = useState<ServerOption[]>([]);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [selected, setSelected] = useState<EventListItem | null>(null);

  const navigate = useCallback(
    (partial: Partial<EventFilters>) => {
      const nextFilters: EventFilters = { ...filters, ...partial };
      const qs = buildQueryString(nextFilters);
      router.replace(qs ? `${pathname}?${qs}` : pathname);
    },
    [filters, pathname, router],
  );

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetch(`/api/v1/events?${buildListApiQuery(filters, { limit: PAGE_LIMIT, lockedServerId })}`, {
      credentials: 'include',
      cache: 'no-store',
    })
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return (await res.json()) as EventListResponse;
      })
      .then((data) => {
        if (cancelled) return;
        setItems(data.items);
        setNextCursor(data.next_cursor);
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
  }, [filters, lockedServerId]);

  useEffect(() => {
    let cancelled = false;
    setTotal(null);
    fetch(`/api/v1/events/count?${buildCountApiQuery(filters, { lockedServerId })}`, {
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
  }, [filters, lockedServerId]);

  useEffect(() => {
    if (lockedServerId) return;
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
  }, [lockedServerId]);

  const loadMore = useCallback(async () => {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const res = await fetch(
        `/api/v1/events?${buildListApiQuery(filters, { cursor: nextCursor, limit: PAGE_LIMIT, lockedServerId })}`,
        { credentials: 'include', cache: 'no-store' },
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as EventListResponse;
      setItems((prev) => appendEventPage(prev, data.items));
      setNextCursor(data.next_cursor);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoadingMore(false);
    }
  }, [filters, nextCursor, loadingMore, lockedServerId]);

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

  const serverOptions = useMemo(() => {
    const merged = new Map<string, ServerOption>();
    for (const option of fetchedServers) merged.set(option.id, option);
    for (const option of serverOptionsFromEvents(items)) {
      if (!merged.has(option.id)) merged.set(option.id, option);
    }
    return Array.from(merged.values()).sort((left, right) =>
      (left.display_name ?? left.slug ?? '').localeCompare(right.display_name ?? right.slug ?? ''),
    );
  }, [fetchedServers, items]);

  const kindOptions = useMemo(() => kindOptionsFromEvents(items), [items]);

  const exportHref = `/api/v1/events/export?${buildExportApiQuery(filters, { lockedServerId })}`;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          {lockedServerId ? (
            <Link
              href={`/servers/${lockedServerId}`}
              className="font-mono text-xs text-sky-400 hover:text-sky-300"
            >
              ← сервер
            </Link>
          ) : null}
          <h1 className="text-2xl font-semibold">Журнал событий</h1>
          <span className="text-xs text-neutral-500">
            {total === null ? 'Всего: …' : `Всего: ${total}`}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <a
            href={exportHref}
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

      {filters.ruleId ? (
        <div className="flex items-center gap-2">
          <span className="inline-flex items-center gap-2 rounded border border-sky-800 bg-sky-950/40 px-2 py-1 text-xs text-sky-200">
            Правило: {filters.ruleId.slice(0, 8)}…
            <button
              type="button"
              onClick={() => navigate({ ruleId: '' })}
              aria-label="Убрать фильтр по правилу"
              className="text-sky-400 hover:text-sky-100"
            >
              ×
            </button>
          </span>
        </div>
      ) : null}

      <div className="flex gap-6">
        <aside className="hidden w-64 shrink-0 lg:block">
          <FilterPanel
            filters={filters}
            servers={serverOptions}
            kinds={kindOptions}
            lockedServerId={lockedServerId}
            onChange={navigate}
          />
        </aside>

        <div className="min-w-0 flex-1 space-y-3">
          <EventList
            items={items}
            loading={loading}
            showServer={!lockedServerId}
            onSelect={setSelected}
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
            <div className="py-2 text-center text-xs text-neutral-600">Больше событий нет</div>
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
            <FilterPanel
              filters={filters}
              servers={serverOptions}
              kinds={kindOptions}
              lockedServerId={lockedServerId}
              onChange={navigate}
            />
          </div>
        </div>
      ) : null}

      {selected ? <EnvelopeModal event={selected} onClose={() => setSelected(null)} /> : null}
    </div>
  );
}

function FilterPanel({
  filters,
  servers,
  kinds,
  lockedServerId,
  onChange,
}: {
  filters: EventFilters;
  servers: ServerOption[];
  kinds: Array<{ value: string; label: string }>;
  lockedServerId: string | undefined;
  onChange: (partial: Partial<EventFilters>) => void;
}) {
  const [playerDraft, setPlayerDraft] = useState(filters.playerQuery);
  useEffect(() => {
    setPlayerDraft(filters.playerQuery);
  }, [filters.playerQuery]);

  function toggleKind(value: string) {
    const active = filters.kinds.includes(value);
    const nextKinds = active
      ? filters.kinds.filter((entry) => entry !== value)
      : [...filters.kinds, value];
    onChange({ kinds: nextKinds });
  }

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
        <span className="text-xs uppercase tracking-widest text-neutral-500">Игрок</span>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            onChange({ playerQuery: playerDraft.trim() });
          }}
        >
          <input
            type="search"
            value={playerDraft}
            onChange={(event) => setPlayerDraft(event.target.value)}
            onBlur={() => onChange({ playerQuery: playerDraft.trim() })}
            placeholder="Ник игрока"
            className="w-full rounded border border-neutral-800 bg-neutral-900 px-2 py-1.5 text-sm focus:border-neutral-600 focus:outline-none"
          />
        </form>
      </div>

      <div className="space-y-1.5">
        <div className="flex items-center justify-between">
          <span className="text-xs uppercase tracking-widest text-neutral-500">Тип события</span>
          {filters.kinds.length > 0 ? (
            <button
              type="button"
              onClick={() => onChange({ kinds: [] })}
              className="text-[11px] text-neutral-500 hover:text-neutral-300"
            >
              Сбросить
            </button>
          ) : null}
        </div>
        <div className="max-h-56 space-y-1 overflow-y-auto rounded border border-neutral-900 p-1">
          {kinds.map((option) => {
            const active = filters.kinds.includes(option.value);
            return (
              <label
                key={option.value}
                className="flex cursor-pointer items-center gap-2 rounded px-1.5 py-1 text-xs text-neutral-300 hover:bg-neutral-900"
              >
                <input
                  type="checkbox"
                  checked={active}
                  onChange={() => toggleKind(option.value)}
                  className="accent-sky-500"
                />
                <span className="truncate">{option.label}</span>
              </label>
            );
          })}
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

      {lockedServerId ? null : (
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
      )}
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

function EventList({
  items,
  loading,
  showServer,
  onSelect,
}: {
  items: EventListItem[];
  loading: boolean;
  showServer: boolean;
  onSelect: (event: EventListItem) => void;
}) {
  if (loading && items.length === 0) {
    return <div className="py-10 text-center text-sm text-neutral-500">Загрузка…</div>;
  }
  if (!loading && items.length === 0) {
    return (
      <div className="rounded border border-dashed border-neutral-800 py-12 text-center text-sm text-neutral-400">
        События не найдены. Измените фильтры.
      </div>
    );
  }
  return (
    <ul className="divide-y divide-neutral-900 rounded border border-neutral-800 bg-neutral-950/40">
      {items.map((event) => (
        <li key={event.event_id}>
          <button
            type="button"
            onClick={() => onSelect(event)}
            className="flex w-full flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2.5 text-left hover:bg-neutral-900/50"
          >
            <span className="w-44 shrink-0 font-mono text-xs text-neutral-500">
              {formatDateTime(event.occurred_at)}
            </span>
            <span
              className={`inline-flex shrink-0 items-center rounded border px-1.5 py-0.5 text-xs ${kindTone(event.kind)}`}
            >
              {kindLabel(event.kind)}
            </span>
            {showServer ? (
              <span className="inline-block rounded bg-neutral-800 px-1.5 py-0.5 text-xs text-neutral-300">
                {shortServerName(event)}
              </span>
            ) : null}
            {event.actor_nickname ? (
              <span className="truncate text-xs text-neutral-300">{event.actor_nickname}</span>
            ) : null}
            <span className="ml-auto font-mono text-[10px] text-neutral-600">
              {event.event_id.slice(0, 8)}
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}

function EnvelopeModal({ event, onClose }: { event: EventListItem; onClose: () => void }) {
  const [envelope, setEnvelope] = useState<EventEnvelope | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setEnvelope(null);
    fetch(`/api/v1/events/${event.event_id}`, { credentials: 'include', cache: 'no-store' })
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return (await res.json()) as EventEnvelope;
      })
      .then((data) => {
        if (!cancelled) setEnvelope(data);
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
  }, [event.event_id]);

  useEffect(() => {
    function onKey(keyEvent: KeyboardEvent) {
      if (keyEvent.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <button
        type="button"
        aria-label="Закрыть"
        onClick={onClose}
        className="absolute inset-0 bg-black/70"
      />
      <div className="relative z-10 flex max-h-[85vh] w-full max-w-2xl flex-col overflow-hidden rounded-lg border border-neutral-800 bg-neutral-950">
        <div className="flex items-start justify-between gap-3 border-b border-neutral-900 p-3">
          <div className="min-w-0 space-y-1">
            <div className="flex items-center gap-2">
              <span
                className={`inline-flex items-center rounded border px-1.5 py-0.5 text-xs ${kindTone(event.kind)}`}
              >
                {kindLabel(event.kind)}
              </span>
              <span className="text-xs text-neutral-500">{formatDateTime(event.occurred_at)}</span>
            </div>
            <div className="truncate font-mono text-[11px] text-neutral-600">{event.event_id}</div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="shrink-0 rounded border border-neutral-800 px-2 py-0.5 text-sm text-neutral-300 hover:border-neutral-600"
          >
            Закрыть
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-auto p-3">
          {loading ? (
            <div className="text-sm text-neutral-500">Загрузка…</div>
          ) : error ? (
            <div className="text-sm text-red-300">Ошибка: {error}</div>
          ) : envelope ? (
            <pre className="overflow-x-auto whitespace-pre-wrap break-words rounded bg-neutral-900 p-3 font-mono text-[11px] leading-relaxed text-neutral-300">
              {JSON.stringify(envelope, null, 2)}
            </pre>
          ) : null}
        </div>
      </div>
    </div>
  );
}
