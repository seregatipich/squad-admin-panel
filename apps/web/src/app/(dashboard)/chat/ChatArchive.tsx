'use client';

import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useId, useMemo, useState } from 'react';
import { LiveIndicator } from '@/components/LiveIndicator';
import type { LiveEvent } from '@/lib/live-bus';
import { useLiveSubscription } from '@/lib/use-live-bus';
import {
  apiItemToRow,
  buildApiQuery,
  buildQueryString,
  CHAT_SCOPES,
  type ChatApiItem,
  type ChatFilters,
  type ChatRow,
  combineRows,
  EMPTY_FILTERS,
  formatArchiveTime,
  hasActiveFilters,
  hasDateFilter,
  liveMessageToRow,
  liveRowMatchesFilters,
  parseFilters,
  playerHref,
  prependLiveRow,
  SCOPE_META,
  scopeMeta,
  teamFlagMeta,
  toggleValue,
} from './helpers';

interface ChatListResponse {
  items: ChatApiItem[];
  next_cursor: string | null;
}

interface ServerOption {
  id: string;
  display_name: string;
}

export function ChatArchive() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const filters = useMemo(() => parseFilters(searchParams), [searchParams]);

  const [pageRows, setPageRows] = useState<ChatRow[]>([]);
  const [liveRows, setLiveRows] = useState<ChatRow[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [liveEnabled, setLiveEnabled] = useState(false);
  const [lastLiveAt, setLastLiveAt] = useState<Date | null>(null);
  const [servers, setServers] = useState<ServerOption[]>([]);
  const [drawerOpen, setDrawerOpen] = useState(false);

  const serverNames = useMemo(() => {
    const map = new Map<string, string>();
    for (const server of servers) map.set(server.id, server.display_name);
    return map;
  }, [servers]);

  const liveAvailable = !hasDateFilter(filters);
  const liveOn = liveEnabled && liveAvailable;

  const navigate = useCallback(
    (partial: Partial<ChatFilters>) => {
      const next: ChatFilters = { ...filters, ...partial };
      const qs = buildQueryString(next);
      router.replace(qs ? `${pathname}?${qs}` : pathname);
    },
    [filters, pathname, router],
  );

  useEffect(() => {
    let cancelled = false;
    fetch('/api/v1/servers', { credentials: 'include', cache: 'no-store' })
      .then((res) => (res.ok ? res.json() : { items: [] }))
      .then((data: { items: ServerOption[] }) => {
        if (!cancelled) setServers(data.items ?? []);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    setLiveRows([]);
    try {
      const res = await fetch(`/api/v1/chat/messages?${buildApiQuery(filters)}`, {
        credentials: 'include',
        cache: 'no-store',
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as ChatListResponse;
      setPageRows(data.items.map(apiItemToRow));
      setCursor(data.next_cursor);
    } catch (err) {
      setError((err as Error).message);
      setPageRows([]);
      setCursor(null);
    } finally {
      setLoading(false);
    }
  }, [filters]);

  useEffect(() => {
    void load();
  }, [load]);

  const loadMore = useCallback(async () => {
    if (!cursor) return;
    setLoadingMore(true);
    try {
      const res = await fetch(`/api/v1/chat/messages?${buildApiQuery(filters, cursor)}`, {
        credentials: 'include',
        cache: 'no-store',
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as ChatListResponse;
      setPageRows((prev) => [...prev, ...data.items.map(apiItemToRow)]);
      setCursor(data.next_cursor);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoadingMore(false);
    }
  }, [cursor, filters]);

  const onChat = useCallback(
    (event: Extract<LiveEvent, { type: 'chat.message' }>) => {
      if (!liveOn) return;
      const row = liveMessageToRow(event.data);
      if (!liveRowMatchesFilters(row, filters)) return;
      setLiveRows((prev) => prependLiveRow(prev, row));
      setLastLiveAt(new Date());
    },
    [liveOn, filters],
  );
  useLiveSubscription('chat.message', onChat);

  useEffect(() => {
    if (!liveAvailable) setLiveRows([]);
  }, [liveAvailable]);

  const rows = useMemo(
    () => combineRows(liveOn ? liveRows : [], pageRows),
    [liveOn, liveRows, pageRows],
  );

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold">Чат</h1>
        <div className="flex items-center gap-2">
          {liveOn ? <LiveIndicator lastUpdate={lastLiveAt} label="сообщение" /> : null}
          <button
            type="button"
            onClick={() => setDrawerOpen(true)}
            className="rounded border border-neutral-800 px-3 py-1.5 text-sm text-neutral-300 hover:border-neutral-600 md:hidden"
          >
            Фильтры
          </button>
        </div>
      </div>

      <p className="text-sm text-neutral-400">
        Глобальный архив внутриигрового чата всех серверов: поиск по игроку и тексту, фильтры по
        серверам, скоупам и дате. Броадкасты админов интерливятся с сообщениями игроков.
      </p>

      <div className="flex gap-6">
        <aside className="hidden w-72 shrink-0 md:block">
          <FilterSidebar
            filters={filters}
            servers={servers}
            liveAvailable={liveAvailable}
            liveEnabled={liveEnabled}
            onToggleLive={() => setLiveEnabled((value) => !value)}
            onChange={navigate}
          />
        </aside>

        <section className="min-w-0 flex-1 space-y-3">
          {error ? (
            <div className="rounded border border-red-900 bg-red-950 p-3 text-sm text-red-200">
              Ошибка загрузки чата: {error}
            </div>
          ) : null}

          <div className="overflow-x-auto rounded border border-neutral-800 bg-neutral-950">
            {loading ? (
              <div className="py-12 text-center text-sm text-neutral-500">Загрузка…</div>
            ) : rows.length === 0 ? (
              <div className="py-12 text-center text-sm text-neutral-500">
                Сообщения не найдены. Измените фильтры или дождитесь новых сообщений.
              </div>
            ) : (
              <table className="w-full min-w-[720px] text-sm">
                <thead className="text-left text-xs uppercase text-neutral-500">
                  <tr>
                    <th className="px-3 py-2 font-medium">Время</th>
                    <th className="px-3 py-2 font-medium">Сервер</th>
                    <th className="px-3 py-2 font-medium">Ком.</th>
                    <th className="px-3 py-2 font-medium">Игрок</th>
                    <th className="px-3 py-2 font-medium">Скоуп</th>
                    <th className="px-3 py-2 font-medium">Сообщение</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <ChatTableRow
                      key={row.key}
                      row={row}
                      serverName={serverNames.get(row.serverId)}
                    />
                  ))}
                </tbody>
              </table>
            )}
          </div>

          {!loading && cursor ? (
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
          ) : null}
        </section>
      </div>

      {drawerOpen ? (
        <div className="fixed inset-0 z-40 md:hidden">
          <button
            type="button"
            aria-label="Закрыть фильтры"
            onClick={() => setDrawerOpen(false)}
            className="absolute inset-0 bg-black/60"
          />
          <div className="absolute inset-y-0 left-0 w-[85%] max-w-sm overflow-y-auto border-r border-neutral-800 bg-neutral-950 p-4">
            <div className="mb-4 flex items-center justify-between">
              <h2 className="text-sm font-semibold text-neutral-200">Фильтры</h2>
              <button
                type="button"
                onClick={() => setDrawerOpen(false)}
                className="rounded border border-neutral-800 px-2 py-1 text-xs text-neutral-300 hover:border-neutral-600"
              >
                Закрыть
              </button>
            </div>
            <FilterSidebar
              filters={filters}
              servers={servers}
              liveAvailable={liveAvailable}
              liveEnabled={liveEnabled}
              onToggleLive={() => setLiveEnabled((value) => !value)}
              onChange={navigate}
            />
          </div>
        </div>
      ) : null}
    </div>
  );
}

function ChatTableRow({ row, serverName }: { row: ChatRow; serverName: string | undefined }) {
  const scope = scopeMeta(row.scope);
  const team = teamFlagMeta(row.teamId);
  const href = playerHref(row);
  return (
    <tr className="border-t border-neutral-900 align-top hover:bg-neutral-900/40">
      <td className="whitespace-nowrap px-3 py-2 font-mono text-[11px] text-neutral-500">
        {formatArchiveTime(row.sentAt)}
      </td>
      <td className="whitespace-nowrap px-3 py-2 text-xs text-neutral-400">
        {serverName ?? `${row.serverId.slice(0, 8)}…`}
      </td>
      <td className="px-3 py-2">
        {team ? (
          <span className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${team.badgeClass}`}>
            {team.label}
          </span>
        ) : (
          <span className="text-neutral-700">—</span>
        )}
      </td>
      <td className="whitespace-nowrap px-3 py-2">
        {href ? (
          <Link href={href} className="font-medium text-sky-400 hover:text-sky-300">
            {row.nickname}
          </Link>
        ) : (
          <span className="font-medium text-neutral-300">{row.nickname}</span>
        )}
      </td>
      <td className="px-3 py-2">
        <span
          className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium ${scope.badgeClass}`}
          title={scope.labelEn}
        >
          <span aria-hidden>{scope.icon}</span>
          {scope.labelRu}
        </span>
      </td>
      <td className="px-3 py-2 text-neutral-200" style={{ wordBreak: 'break-word' }}>
        {row.isFlagged ? (
          <span
            className="mr-1.5 rounded bg-red-950 px-1.5 py-0.5 text-[10px] uppercase text-red-300"
            title="Помечено фильтром чата"
          >
            флаг
          </span>
        ) : null}
        {row.message}
      </td>
    </tr>
  );
}

function FilterSidebar({
  filters,
  servers,
  liveAvailable,
  liveEnabled,
  onToggleLive,
  onChange,
}: {
  filters: ChatFilters;
  servers: ServerOption[];
  liveAvailable: boolean;
  liveEnabled: boolean;
  onToggleLive: () => void;
  onChange: (partial: Partial<ChatFilters>) => void;
}) {
  const [playerDraft, setPlayerDraft] = useState(filters.playerQuery);
  const [textDraft, setTextDraft] = useState(filters.text);
  const playerId = useId();
  const textId = useId();
  const fromId = useId();
  const toId = useId();

  useEffect(() => {
    setPlayerDraft(filters.playerQuery);
  }, [filters.playerQuery]);
  useEffect(() => {
    setTextDraft(filters.text);
  }, [filters.text]);

  return (
    <div className="space-y-4 rounded border border-neutral-800 bg-neutral-950 p-4">
      <form
        onSubmit={(event) => {
          event.preventDefault();
          onChange({ playerQuery: playerDraft.trim(), text: textDraft.trim() });
        }}
        className="space-y-3"
      >
        <div className="space-y-1">
          <label htmlFor={playerId} className="text-xs text-neutral-500">
            Игрок (ник / SteamID / EOS)
          </label>
          <input
            id={playerId}
            type="search"
            value={playerDraft}
            onChange={(event) => setPlayerDraft(event.target.value)}
            placeholder="Поиск игрока"
            className="w-full rounded border border-neutral-800 bg-neutral-900 px-2 py-1.5 text-xs focus:border-neutral-600 focus:outline-none"
          />
        </div>
        <div className="space-y-1">
          <label htmlFor={textId} className="text-xs text-neutral-500">
            Текст сообщения
          </label>
          <input
            id={textId}
            type="search"
            value={textDraft}
            onChange={(event) => setTextDraft(event.target.value)}
            placeholder="Поиск по тексту"
            className="w-full rounded border border-neutral-800 bg-neutral-900 px-2 py-1.5 text-xs focus:border-neutral-600 focus:outline-none"
          />
        </div>
        <button
          type="submit"
          className="w-full rounded border border-neutral-700 px-3 py-1.5 text-xs text-neutral-200 hover:border-neutral-500"
        >
          Применить
        </button>
      </form>

      <div className="space-y-2">
        <span className="text-xs text-neutral-500">Скоупы</span>
        <div className="flex flex-wrap gap-1.5">
          {CHAT_SCOPES.map((scope) => {
            const active = filters.scopes.includes(scope);
            const meta = SCOPE_META[scope];
            return (
              <button
                key={scope}
                type="button"
                onClick={() => onChange({ scopes: toggleValue(filters.scopes, scope) })}
                aria-pressed={active}
                className={`inline-flex items-center gap-1 rounded px-2 py-0.5 text-[11px] font-medium ${
                  active ? meta.badgeClass : 'border border-neutral-700 text-neutral-400'
                }`}
              >
                <span aria-hidden>{meta.icon}</span>
                {meta.labelRu}
              </button>
            );
          })}
        </div>
      </div>

      {servers.length > 0 ? (
        <div className="space-y-2">
          <span className="text-xs text-neutral-500">Серверы</span>
          <div className="flex flex-wrap gap-1.5">
            {servers.map((server) => {
              const active = filters.serverIds.includes(server.id);
              return (
                <button
                  key={server.id}
                  type="button"
                  onClick={() => onChange({ serverIds: toggleValue(filters.serverIds, server.id) })}
                  aria-pressed={active}
                  className={`rounded px-2 py-0.5 text-[11px] font-medium ${
                    active
                      ? 'bg-neutral-700 text-neutral-100'
                      : 'border border-neutral-700 text-neutral-400'
                  }`}
                >
                  {server.display_name}
                </button>
              );
            })}
          </div>
        </div>
      ) : null}

      <div className="grid grid-cols-2 gap-2">
        <div className="space-y-1">
          <label htmlFor={fromId} className="text-xs text-neutral-500">
            С даты
          </label>
          <input
            id={fromId}
            type="date"
            value={filters.from}
            onChange={(event) => onChange({ from: event.target.value })}
            className="w-full rounded border border-neutral-800 bg-neutral-900 px-2 py-1.5 text-xs text-neutral-200 focus:border-neutral-600 focus:outline-none"
          />
        </div>
        <div className="space-y-1">
          <label htmlFor={toId} className="text-xs text-neutral-500">
            По дату
          </label>
          <input
            id={toId}
            type="date"
            value={filters.to}
            onChange={(event) => onChange({ to: event.target.value })}
            className="w-full rounded border border-neutral-800 bg-neutral-900 px-2 py-1.5 text-xs text-neutral-200 focus:border-neutral-600 focus:outline-none"
          />
        </div>
      </div>

      <label className="flex items-center gap-2 text-xs text-neutral-300">
        <input
          type="checkbox"
          checked={filters.flaggedOnly}
          onChange={(event) => onChange({ flaggedOnly: event.target.checked })}
          className="h-3.5 w-3.5 accent-red-500"
        />
        Только флагнутые
      </label>

      <div className="flex items-center justify-between border-t border-neutral-900 pt-3">
        <label className="flex items-center gap-2 text-xs text-neutral-300">
          <input
            type="checkbox"
            checked={liveEnabled && liveAvailable}
            disabled={!liveAvailable}
            onChange={onToggleLive}
            className="h-3.5 w-3.5 accent-green-500"
          />
          <span className={liveAvailable ? '' : 'text-neutral-600'}>Live</span>
        </label>
        {hasActiveFilters(filters) ? (
          <button
            type="button"
            onClick={() => onChange(EMPTY_FILTERS)}
            className="text-xs text-neutral-500 hover:text-neutral-300"
          >
            Сбросить
          </button>
        ) : null}
      </div>
      {!liveAvailable ? (
        <p className="text-[11px] text-neutral-600">
          Live недоступен при фильтре по дате — очистите даты, чтобы получать новые сообщения.
        </p>
      ) : null}
    </div>
  );
}
