'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

import type { LiveEvent } from '@/lib/live-bus';
import { useLiveSubscription } from '@/lib/use-live-bus';
import {
  buildChatQuery,
  CHAT_SCOPE_OPTIONS,
  CHAT_SOURCE_OPTIONS,
  type ChatFilters,
  type ChatMsg,
  type ChatPage,
  EMPTY_CHAT_FILTERS,
  formatChatTs,
  liveToChatMsg,
  matchesFilters,
  mergeChatPage,
  prependLiveMessage,
  scopeLabel,
  sourceLabel,
  thirtyDayCountQuery,
} from './chat-history';

interface ServerOption {
  id: string;
  display_name: string;
}

export function ChatHistorySection({ playerId }: { playerId: string }) {
  const [filters, setFilters] = useState<ChatFilters>(EMPTY_CHAT_FILTERS);
  const [applied, setApplied] = useState<ChatFilters>(EMPTY_CHAT_FILTERS);
  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [monthlyCount, setMonthlyCount] = useState<number | null>(null);
  const [servers, setServers] = useState<ServerOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const appliedRef = useRef<ChatFilters>(EMPTY_CHAT_FILTERS);

  useEffect(() => {
    appliedRef.current = applied;
  }, [applied]);

  useEffect(() => {
    fetch('/api/v1/servers', { credentials: 'include', cache: 'no-store' })
      .then((res) => (res.ok ? res.json() : null))
      .then((body: { items?: ServerOption[] } | null) => {
        if (body?.items) setServers(body.items);
      })
      .catch(() => {});
  }, []);

  const serverName = useCallback(
    (serverId: string) => servers.find((s) => s.id === serverId)?.display_name ?? serverId,
    [servers],
  );

  const load = useCallback(
    async (next: ChatFilters) => {
      setLoading(true);
      setError(null);
      try {
        const [listRes, countRes] = await Promise.all([
          fetch(`/api/v1/chat/messages${buildChatQuery(playerId, next)}`, {
            credentials: 'include',
            cache: 'no-store',
          }),
          fetch(`/api/v1/chat/messages/count${thirtyDayCountQuery(playerId)}`, {
            credentials: 'include',
            cache: 'no-store',
          }),
        ]);
        if (!listRes.ok) throw new Error(`HTTP ${listRes.status}`);
        const page = (await listRes.json()) as ChatPage;
        setMessages(mergeChatPage([], page.items, false));
        setNextCursor(page.next_cursor);
        if (countRes.ok) {
          setMonthlyCount(((await countRes.json()) as { count: number }).count);
        }
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setLoading(false);
      }
    },
    [playerId],
  );

  useEffect(() => {
    setApplied(EMPTY_CHAT_FILTERS);
    setFilters(EMPTY_CHAT_FILTERS);
    void load(EMPTY_CHAT_FILTERS);
  }, [load]);

  async function loadMore() {
    if (!nextCursor || busy) return;
    setBusy(true);
    try {
      const res = await fetch(
        `/api/v1/chat/messages${buildChatQuery(playerId, applied, nextCursor)}`,
        { credentials: 'include', cache: 'no-store' },
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const page = (await res.json()) as ChatPage;
      setMessages((prev) => mergeChatPage(prev, page.items, true));
      setNextCursor(page.next_cursor);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function applyFilters() {
    setApplied(filters);
    void load(filters);
  }

  function resetFilters() {
    setFilters(EMPTY_CHAT_FILTERS);
    setApplied(EMPTY_CHAT_FILTERS);
    void load(EMPTY_CHAT_FILTERS);
  }

  const onLiveMessage = useCallback(
    (event: Extract<LiveEvent, { type: 'chat.message' }>) => {
      if (event.data.player_id !== playerId) return;
      const row = liveToChatMsg(event.data);
      if (!row || !matchesFilters(row, appliedRef.current)) return;
      setMessages((prev) => prependLiveMessage(prev, row));
      setMonthlyCount((prev) => (prev === null ? prev : prev + 1));
    },
    [playerId],
  );
  useLiveSubscription('chat.message', onLiveMessage);

  function setField<K extends keyof ChatFilters>(key: K, value: ChatFilters[K]) {
    setFilters((prev) => ({ ...prev, [key]: value }));
  }

  return (
    <section className="rounded border border-neutral-800 bg-neutral-950 p-4 space-y-4">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-xs uppercase tracking-widest text-neutral-400">
          Чат
          <span
            className="ml-2 rounded-full bg-neutral-800 px-2 py-0.5 text-[11px] text-neutral-200 tabular-nums"
            title="Сообщений за 30 дней"
          >
            {monthlyCount ?? '—'} / 30д
          </span>
        </h2>
      </div>

      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
        <label className="flex flex-col gap-1 text-xs text-neutral-500">
          Сервер
          <select
            value={filters.serverId}
            onChange={(e) => setField('serverId', e.target.value)}
            className="rounded border border-neutral-800 bg-neutral-950 px-2 py-1.5 text-sm text-neutral-100"
          >
            <option value="">Все серверы</option>
            {servers.map((server) => (
              <option key={server.id} value={server.id}>
                {server.display_name}
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1 text-xs text-neutral-500">
          Канал
          <select
            value={filters.scope}
            onChange={(e) => setField('scope', e.target.value)}
            className="rounded border border-neutral-800 bg-neutral-950 px-2 py-1.5 text-sm text-neutral-100"
          >
            <option value="">Все каналы</option>
            {CHAT_SCOPE_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1 text-xs text-neutral-500">
          Источник
          <select
            value={filters.source}
            onChange={(e) => setField('source', e.target.value)}
            className="rounded border border-neutral-800 bg-neutral-950 px-2 py-1.5 text-sm text-neutral-100"
          >
            <option value="">Любой</option>
            {CHAT_SOURCE_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1 text-xs text-neutral-500">
          С даты
          <input
            type="date"
            value={filters.from}
            onChange={(e) => setField('from', e.target.value)}
            className="rounded border border-neutral-800 bg-neutral-950 px-2 py-1.5 text-sm text-neutral-100"
          />
        </label>

        <label className="flex flex-col gap-1 text-xs text-neutral-500">
          По дату
          <input
            type="date"
            value={filters.to}
            onChange={(e) => setField('to', e.target.value)}
            className="rounded border border-neutral-800 bg-neutral-950 px-2 py-1.5 text-sm text-neutral-100"
          />
        </label>

        <label className="flex flex-col gap-1 text-xs text-neutral-500">
          Текст
          <input
            type="search"
            value={filters.text}
            onChange={(e) => setField('text', e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') applyFilters();
            }}
            placeholder="поиск по сообщению"
            className="rounded border border-neutral-800 bg-neutral-950 px-2 py-1.5 text-sm text-neutral-100"
          />
        </label>
      </div>

      <div className="flex gap-2">
        <button
          type="button"
          onClick={applyFilters}
          className="rounded bg-sky-600 px-4 py-1.5 text-sm text-white hover:bg-sky-500"
        >
          Применить
        </button>
        <button
          type="button"
          onClick={resetFilters}
          className="rounded border border-neutral-800 px-4 py-1.5 text-sm hover:border-neutral-600"
        >
          Сбросить
        </button>
      </div>

      {error ? (
        <div className="rounded border border-red-900 bg-red-950 p-2 text-xs text-red-200">
          Ошибка: {error}
        </div>
      ) : null}

      {loading ? (
        <div className="text-sm text-neutral-500">Загрузка…</div>
      ) : messages.length === 0 ? (
        <div className="rounded border border-dashed border-neutral-800 p-6 text-center text-sm text-neutral-500">
          Нет сообщений
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] text-sm">
            <thead className="text-xs uppercase tracking-widest text-neutral-500">
              <tr>
                <th className="p-1 text-left">Время</th>
                <th className="p-1 text-left">Сервер</th>
                <th className="p-1 text-left">Канал</th>
                <th className="p-1 text-left">Источник</th>
                <th className="p-1 text-left">Сообщение</th>
              </tr>
            </thead>
            <tbody>
              {messages.map((message) => (
                <tr key={message.id} className="border-t border-neutral-900 align-top">
                  <td className="whitespace-nowrap p-1 font-mono text-neutral-400">
                    {formatChatTs(message.sentAt)}
                  </td>
                  <td className="p-1 text-neutral-300">{serverName(message.serverId)}</td>
                  <td className="p-1">
                    <span className="rounded bg-neutral-800 px-1.5 py-0.5 text-[11px] text-neutral-200">
                      {scopeLabel(message.scope)}
                    </span>
                  </td>
                  <td className="p-1 text-neutral-500">{sourceLabel(message.source)}</td>
                  <td className="p-1 text-neutral-100">
                    <span className="whitespace-pre-wrap break-words">{message.message}</span>
                    {message.isFlagged ? (
                      <span className="ml-2 rounded bg-red-950 px-1.5 py-0.5 text-[10px] uppercase text-red-300">
                        флаг
                      </span>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {nextCursor ? (
        <div className="flex justify-center">
          <button
            type="button"
            onClick={() => void loadMore()}
            disabled={busy}
            className="rounded border border-neutral-800 px-3 py-1 text-xs hover:border-neutral-600 disabled:opacity-40"
          >
            Показать ещё
          </button>
        </div>
      ) : null}
    </section>
  );
}
