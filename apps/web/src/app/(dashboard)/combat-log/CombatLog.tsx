'use client';

import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { LiveIndicator } from '@/components/LiveIndicator';
import type { LiveEvent } from '@/lib/live-bus';
import { useLiveSubscription } from '@/lib/use-live-bus';
import {
  appendPage,
  buildExportApiQuery,
  buildListApiQuery,
  buildQueryString,
  COMBAT_FACETS,
  type CombatApiRow,
  type CombatFilters,
  type CombatListResponse,
  type CombatPlayer,
  combatEventToRow,
  DATE_PRESETS,
  defaultFilters,
  eventTypeMeta,
  facetLabel,
  formatDamage,
  formatEventTime,
  hasActiveFilters,
  PAGE_LIMIT,
  parseFilters,
  playerHref,
  playerLabel,
  prependLiveRow,
  type SortDir,
  shortServerLabel,
  showsDamageColumn,
  sortRowsByDamage,
} from './helpers';

interface ServerOption {
  id: string;
  display_name: string | null;
  slug: string | null;
}

interface ServersResponse {
  items: ServerOption[];
}

interface PlayersResponse {
  items: Array<{ id: string; canonical_name: string | null }>;
}

export function CombatLog({ lockedServerId }: { lockedServerId?: string }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const filters = useMemo(() => parseFilters(searchParams), [searchParams]);

  const [rows, setRows] = useState<CombatApiRow[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [approxTotal, setApproxTotal] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [servers, setServers] = useState<ServerOption[]>([]);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [damageSort, setDamageSort] = useState<SortDir>('desc');
  const [liveEnabled, setLiveEnabled] = useState(false);
  const [lastLiveAt, setLastLiveAt] = useState<Date | null>(null);

  const damageVisible = showsDamageColumn(filters.facet);

  const serverNames = useMemo(() => {
    const map = new Map<string, string>();
    for (const server of servers) {
      map.set(server.id, server.display_name ?? server.slug ?? server.id.slice(0, 8));
    }
    return map;
  }, [servers]);

  const navigate = useCallback(
    (partial: Partial<CombatFilters>) => {
      const next: CombatFilters = { ...filters, ...partial };
      const qs = buildQueryString(next);
      router.replace(qs ? `${pathname}?${qs}` : pathname);
    },
    [filters, pathname, router],
  );

  useEffect(() => {
    if (lockedServerId) return;
    let cancelled = false;
    fetch('/api/v1/servers', { credentials: 'include', cache: 'no-store' })
      .then((res) => (res.ok ? res.json() : { items: [] }))
      .then((data: ServersResponse) => {
        if (!cancelled) setServers(data.items ?? []);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [lockedServerId]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setApproxTotal(null);
    fetch(
      `/api/v1/combat-events?${buildListApiQuery(filters, { limit: PAGE_LIMIT, lockedServerId })}`,
      {
        credentials: 'include',
        cache: 'no-store',
      },
    )
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return (await res.json()) as CombatListResponse;
      })
      .then((data) => {
        if (cancelled) return;
        setRows(data.rows);
        setNextCursor(data.nextCursor);
        setApproxTotal(data.approxTotal);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setError((err as Error).message);
          setRows([]);
          setNextCursor(null);
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [filters, lockedServerId]);

  const loadMore = useCallback(async () => {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const res = await fetch(
        `/api/v1/combat-events?${buildListApiQuery(filters, { cursor: nextCursor, limit: PAGE_LIMIT, lockedServerId })}`,
        { credentials: 'include', cache: 'no-store' },
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as CombatListResponse;
      setRows((prev) => appendPage(prev, data.rows));
      setNextCursor(data.nextCursor);
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

  const onCombat = useCallback(
    (event: Extract<LiveEvent, { type: 'combat.event' }>) => {
      if (!liveEnabled) return;
      if (lockedServerId && event.data.server_id !== lockedServerId) return;
      setRows((prev) => prependLiveRow(prev, combatEventToRow(event.data)));
      setLastLiveAt(new Date());
    },
    [liveEnabled, lockedServerId],
  );
  useLiveSubscription('combat.event', onCombat);

  const displayRows = useMemo(
    () => (damageVisible ? sortRowsByDamage(rows, damageSort) : rows),
    [rows, damageVisible, damageSort],
  );

  const exportHref = `/api/v1/combat-events/export?${buildExportApiQuery(filters, { lockedServerId })}`;

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
          <h1 className="text-2xl font-semibold">Боевой лог</h1>
          <span className="text-xs text-neutral-500">
            {approxTotal === null ? '≈ …' : `≈ ${approxTotal.toLocaleString('ru-RU')}`}
          </span>
        </div>
        <div className="flex items-center gap-2">
          {liveEnabled ? <LiveIndicator lastUpdate={lastLiveAt} label="событие" /> : null}
          <label className="flex items-center gap-1.5 text-xs text-neutral-300">
            <input
              type="checkbox"
              checked={liveEnabled}
              onChange={(event) => setLiveEnabled(event.target.checked)}
              className="h-3.5 w-3.5 accent-green-500"
            />
            Live
          </label>
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

      <div className="flex flex-wrap gap-1.5">
        {COMBAT_FACETS.map((facet) => {
          const active = filters.facet === facet;
          return (
            <button
              key={facet}
              type="button"
              onClick={() => navigate({ facet })}
              aria-pressed={active}
              className={`rounded-full px-3 py-1 text-sm transition-colors ${
                active
                  ? 'bg-sky-900 text-sky-100'
                  : 'border border-neutral-800 text-neutral-400 hover:border-neutral-600 hover:text-neutral-200'
              }`}
            >
              {facetLabel(facet)}
            </button>
          );
        })}
      </div>

      {error ? (
        <div className="rounded border border-red-900 bg-red-950 p-3 text-sm text-red-200">
          Ошибка загрузки боевого лога: {error}
        </div>
      ) : null}

      <div className="flex gap-6">
        <aside className="hidden w-64 shrink-0 lg:block">
          <FilterPanel
            filters={filters}
            servers={servers}
            lockedServerId={lockedServerId}
            onChange={navigate}
          />
        </aside>

        <div className="min-w-0 flex-1 space-y-3">
          <CombatTable
            rows={displayRows}
            loading={loading}
            showServer={!lockedServerId}
            serverNames={serverNames}
            damageVisible={damageVisible}
            damageSort={damageSort}
            onToggleDamageSort={() => setDamageSort((prev) => (prev === 'desc' ? 'asc' : 'desc'))}
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
          ) : !loading && displayRows.length > 0 ? (
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
              servers={servers}
              lockedServerId={lockedServerId}
              onChange={navigate}
            />
          </div>
        </div>
      ) : null}
    </div>
  );
}

function PlayerLink({ player }: { player: CombatPlayer | null }) {
  const href = playerHref(player);
  const label = playerLabel(player);
  if (href) {
    return (
      <Link href={href} className="font-medium text-sky-400 hover:text-sky-300">
        {label}
      </Link>
    );
  }
  return <span className="text-neutral-500">{label}</span>;
}

function TeamkillBadge() {
  return (
    <span className="rounded bg-red-950 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-red-300">
      TK
    </span>
  );
}

function CombatTable({
  rows,
  loading,
  showServer,
  serverNames,
  damageVisible,
  damageSort,
  onToggleDamageSort,
}: {
  rows: CombatApiRow[];
  loading: boolean;
  showServer: boolean;
  serverNames: Map<string, string>;
  damageVisible: boolean;
  damageSort: SortDir;
  onToggleDamageSort: () => void;
}) {
  if (loading && rows.length === 0) {
    return <div className="py-12 text-center text-sm text-neutral-500">Загрузка…</div>;
  }
  if (!loading && rows.length === 0) {
    return (
      <div className="rounded border border-dashed border-neutral-800 py-12 text-center text-sm text-neutral-400">
        Боевых событий не найдено. Измените фильтры.
      </div>
    );
  }

  return (
    <>
      <div className="hidden overflow-x-auto rounded border border-neutral-800 bg-neutral-950 md:block">
        <table className="w-full min-w-[720px] text-sm">
          <thead className="text-left text-xs uppercase text-neutral-500">
            <tr>
              <th className="px-3 py-2 font-medium">Время</th>
              {showServer ? <th className="px-3 py-2 font-medium">Сервер</th> : null}
              <th className="px-3 py-2 font-medium">Кто</th>
              <th className="px-3 py-2 font-medium">Кого</th>
              <th className="px-3 py-2 font-medium">Оружие</th>
              {damageVisible ? (
                <th className="px-3 py-2 font-medium">
                  <button
                    type="button"
                    onClick={onToggleDamageSort}
                    className="inline-flex items-center gap-1 uppercase text-neutral-400 hover:text-neutral-200"
                  >
                    Урон
                    <span aria-hidden>{damageSort === 'desc' ? '▼' : '▲'}</span>
                  </button>
                </th>
              ) : null}
              <th className="px-3 py-2 font-medium">TK</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const meta = eventTypeMeta(row.eventType);
              return (
                <tr
                  key={row.id}
                  className="border-t border-neutral-900 align-top hover:bg-neutral-900/40"
                >
                  <td
                    className="whitespace-nowrap px-3 py-2 font-mono text-[11px] text-neutral-500"
                    title={row.occurredAt}
                  >
                    {formatEventTime(row.occurredAt)}
                  </td>
                  {showServer ? (
                    <td className="whitespace-nowrap px-3 py-2 text-xs text-neutral-400">
                      {shortServerLabel(serverNames, row.serverId)}
                    </td>
                  ) : null}
                  <td className="whitespace-nowrap px-3 py-2">
                    <PlayerLink player={row.attacker} />
                  </td>
                  <td className="whitespace-nowrap px-3 py-2">
                    <PlayerLink player={row.victim} />
                  </td>
                  <td className="px-3 py-2 text-neutral-300">
                    <span className="flex items-center gap-2">
                      <span
                        className={`inline-flex shrink-0 items-center rounded px-1.5 py-0.5 text-[10px] font-medium ${meta.badgeClass}`}
                        title={meta.labelRu}
                      >
                        {meta.labelRu}
                      </span>
                      <span className="font-mono text-xs">{row.weapon ?? '—'}</span>
                    </span>
                  </td>
                  {damageVisible ? (
                    <td className="whitespace-nowrap px-3 py-2 font-mono text-xs text-amber-200">
                      {formatDamage(row.damage)}
                    </td>
                  ) : null}
                  <td className="px-3 py-2">
                    {row.isTeamkill ? (
                      <TeamkillBadge />
                    ) : (
                      <span className="text-neutral-700">—</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <ul className="space-y-2 md:hidden">
        {rows.map((row) => {
          const meta = eventTypeMeta(row.eventType);
          return (
            <li
              key={row.id}
              className="rounded border border-neutral-800 bg-neutral-950 p-3 text-sm"
            >
              <div className="mb-2 flex items-center justify-between gap-2">
                <span
                  className={`inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-medium ${meta.badgeClass}`}
                >
                  {meta.labelRu}
                </span>
                <span className="font-mono text-[11px] text-neutral-500" title={row.occurredAt}>
                  {formatEventTime(row.occurredAt)}
                </span>
              </div>
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <PlayerLink player={row.attacker} />
                <span className="text-neutral-600">→</span>
                <PlayerLink player={row.victim} />
                {row.isTeamkill ? <TeamkillBadge /> : null}
              </div>
              <div className="mt-1 flex flex-wrap items-center gap-x-3 text-xs text-neutral-400">
                <span className="font-mono">{row.weapon ?? '—'}</span>
                {showServer ? <span>{shortServerLabel(serverNames, row.serverId)}</span> : null}
                {damageVisible ? (
                  <span className="font-mono text-amber-200">Урон: {formatDamage(row.damage)}</span>
                ) : null}
              </div>
            </li>
          );
        })}
      </ul>
    </>
  );
}

function FilterPanel({
  filters,
  servers,
  lockedServerId,
  onChange,
}: {
  filters: CombatFilters;
  servers: ServerOption[];
  lockedServerId: string | undefined;
  onChange: (partial: Partial<CombatFilters>) => void;
}) {
  return (
    <div className="space-y-5 text-sm">
      <PlayerAutocomplete
        label="Кто"
        placeholder="Ник атакующего"
        value={filters.attackerQuery}
        onCommit={(value) => onChange({ attackerQuery: value, attackerPlayerId: '' })}
      />
      <PlayerAutocomplete
        label="Кого"
        placeholder="Ник цели"
        value={filters.victimQuery}
        onCommit={(value) => onChange({ victimQuery: value, victimPlayerId: '' })}
      />
      <WeaponInput value={filters.weapon} onCommit={(value) => onChange({ weapon: value })} />

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

      {lockedServerId ? null : (
        <div className="space-y-1.5">
          <span className="text-xs uppercase tracking-widest text-neutral-500">Серверы</span>
          {servers.length === 0 ? (
            <p className="text-xs text-neutral-600">Нет доступных серверов</p>
          ) : (
            <div className="max-h-48 space-y-1 overflow-y-auto rounded border border-neutral-900 p-1">
              {servers.map((server) => {
                const active = filters.serverIds.includes(server.id);
                return (
                  <label
                    key={server.id}
                    className="flex cursor-pointer items-center gap-2 rounded px-1.5 py-1 text-xs text-neutral-300 hover:bg-neutral-900"
                  >
                    <input
                      type="checkbox"
                      checked={active}
                      onChange={() => {
                        const next = active
                          ? filters.serverIds.filter((id) => id !== server.id)
                          : [...filters.serverIds, server.id];
                        onChange({ serverIds: next });
                      }}
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

      {hasActiveFilters(filters) ? (
        <button
          type="button"
          onClick={() => onChange(defaultFilters())}
          className="text-xs text-neutral-500 hover:text-neutral-300"
        >
          Сбросить фильтры
        </button>
      ) : null}
    </div>
  );
}

function PlayerAutocomplete({
  label,
  placeholder,
  value,
  onCommit,
}: {
  label: string;
  placeholder: string;
  value: string;
  onCommit: (value: string) => void;
}) {
  const [draft, setDraft] = useState(value);
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const listId = useId();

  useEffect(() => {
    setDraft(value);
  }, [value]);

  useEffect(() => {
    const query = draft.trim();
    if (query.length < 2) {
      setSuggestions([]);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      fetch(`/api/v1/players?q=${encodeURIComponent(query)}`, {
        credentials: 'include',
        cache: 'no-store',
      })
        .then((res) => (res.ok ? res.json() : { items: [] }))
        .then((data: PlayersResponse) => {
          if (cancelled) return;
          const names = data.items
            .map((item) => item.canonical_name)
            .filter((name): name is string => Boolean(name));
          setSuggestions(Array.from(new Set(names)).slice(0, 10));
        })
        .catch(() => {});
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [draft]);

  return (
    <div className="space-y-1.5">
      <span className="text-xs uppercase tracking-widest text-neutral-500">{label}</span>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          onCommit(draft.trim());
        }}
      >
        <input
          type="search"
          list={listId}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={() => onCommit(draft.trim())}
          placeholder={placeholder}
          className="w-full rounded border border-neutral-800 bg-neutral-900 px-2 py-1.5 text-sm focus:border-neutral-600 focus:outline-none"
        />
        <datalist id={listId}>
          {suggestions.map((name) => (
            <option key={name} value={name} />
          ))}
        </datalist>
      </form>
    </div>
  );
}

function WeaponInput({ value, onCommit }: { value: string; onCommit: (value: string) => void }) {
  const [draft, setDraft] = useState(value);
  useEffect(() => {
    setDraft(value);
  }, [value]);
  return (
    <div className="space-y-1.5">
      <span className="text-xs uppercase tracking-widest text-neutral-500">Оружие</span>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          onCommit(draft.trim());
        }}
      >
        <input
          type="search"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={() => onCommit(draft.trim())}
          placeholder="Напр. AK74"
          className="w-full rounded border border-neutral-800 bg-neutral-900 px-2 py-1.5 text-sm focus:border-neutral-600 focus:outline-none"
        />
      </form>
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
