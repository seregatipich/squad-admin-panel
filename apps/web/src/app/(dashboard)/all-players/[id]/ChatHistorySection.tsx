'use client';

import { useCallback, useEffect, useId, useRef, useState } from 'react';

import {
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  EmptyState,
  InlineBanner,
  SearchField,
  Select,
  SkeletonTable,
  Table,
  TableBody,
  TableHead,
  TableRow,
  Td,
  TextInput,
  Th,
  Toolbar,
} from '@/components/ui';
import { formatDateTimeRu } from '@/lib/format';
import type { LiveEvent } from '@/lib/live-bus';
import { useLiveSubscription } from '@/lib/use-live-bus';
import {
  buildChatQuery,
  CHAT_SCOPE_OPTIONS,
  CHAT_SOURCE_OPTIONS,
  type ChatFilters,
  type ChatMsg,
  EMPTY_CHAT_FILTERS,
  liveToChatMsg,
  matchesFilters,
  mergeChatPage,
  parseChatCount,
  parseChatPage,
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
  // Tracks the most recently started load()/loadMore() request; a response is
  // applied only if it is still current, so a slower loadMore() can never
  // overwrite a fresher filter-driven load() (see finding #433).
  const requestIdRef = useRef(0);
  const serverFilterId = useId();
  const scopeFilterId = useId();
  const sourceFilterId = useId();
  const fromFilterId = useId();
  const toFilterId = useId();

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
      const requestId = ++requestIdRef.current;
      setLoading(true);
      setError(null);
      try {
        const listRes = await fetch(`/api/v1/chat/messages${buildChatQuery(playerId, next)}`, {
          credentials: 'include',
          cache: 'no-store',
        });
        if (!listRes.ok) throw new Error(`HTTP ${listRes.status}`);
        const page = parseChatPage(await listRes.json());
        if (requestIdRef.current !== requestId) return;
        if (!page) throw new Error('Неожиданный формат ответа сервера.');
        setMessages(mergeChatPage([], page.items, false));
        setNextCursor(page.next_cursor);
      } catch (e) {
        if (requestIdRef.current !== requestId) return;
        setError((e as Error).message);
      } finally {
        if (requestIdRef.current === requestId) setLoading(false);
      }
    },
    [playerId],
  );

  useEffect(() => {
    setApplied(EMPTY_CHAT_FILTERS);
    setFilters(EMPTY_CHAT_FILTERS);
    void load(EMPTY_CHAT_FILTERS);
  }, [load]);

  // The 30-day badge is independent of the filters (#436): it does not need
  // to be re-fetched on every "Применить"/"Сбросить"/search, only once per
  // player. Live chat events keep it current after that (onLiveMessage).
  useEffect(() => {
    let cancelled = false;
    fetch(`/api/v1/chat/messages/count${thirtyDayCountQuery(playerId)}`, {
      credentials: 'include',
      cache: 'no-store',
    })
      .then((res) => (res.ok ? res.json() : null))
      .then((body: unknown) => {
        const count = parseChatCount(body);
        if (!cancelled && count !== null) setMonthlyCount(count);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [playerId]);

  async function loadMore() {
    if (!nextCursor || busy) return;
    const requestId = ++requestIdRef.current;
    setBusy(true);
    try {
      const res = await fetch(
        `/api/v1/chat/messages${buildChatQuery(playerId, applied, nextCursor)}`,
        { credentials: 'include', cache: 'no-store' },
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const page = parseChatPage(await res.json());
      if (requestIdRef.current !== requestId) return;
      if (!page) throw new Error('Неожиданный формат ответа сервера.');
      setMessages((prev) => mergeChatPage(prev, page.items, true));
      setNextCursor(page.next_cursor);
    } catch (e) {
      if (requestIdRef.current !== requestId) return;
      setError((e as Error).message);
    } finally {
      if (requestIdRef.current === requestId) setBusy(false);
    }
  }

  function apply(next: ChatFilters) {
    setFilters(next);
    setApplied(next);
    void load(next);
  }

  function resetFilters() {
    apply(EMPTY_CHAT_FILTERS);
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

  const filtersApplied =
    applied.serverId !== '' ||
    applied.scope !== '' ||
    applied.source !== '' ||
    applied.from !== '' ||
    applied.to !== '' ||
    applied.text !== '';

  return (
    <Card as="section" padding="none">
      <CardHeader
        title="Чат"
        count={
          <Badge size="sm" title="Сообщений за 30 дней">
            {monthlyCount ?? '—'} / 30д
          </Badge>
        }
      />

      <CardBody className="space-y-4">
        <Toolbar
          search={
            <SearchField
              value={applied.text}
              onCommit={(text) => apply({ ...filters, text })}
              label="Поиск по сообщениям"
              placeholder="Поиск по тексту сообщения…"
              clearLabel="Очистить поиск"
            />
          }
          filters={
            <>
              <label
                htmlFor={serverFilterId}
                className="flex items-center gap-1.5 text-xs text-ink-3"
              >
                Сервер
                <Select
                  id={serverFilterId}
                  size="sm"
                  value={filters.serverId}
                  onChange={(e) => setField('serverId', e.target.value)}
                >
                  <option value="">Все серверы</option>
                  {servers.map((server) => (
                    <option key={server.id} value={server.id}>
                      {server.display_name}
                    </option>
                  ))}
                </Select>
              </label>

              <label
                htmlFor={scopeFilterId}
                className="flex items-center gap-1.5 text-xs text-ink-3"
              >
                Канал
                <Select
                  id={scopeFilterId}
                  size="sm"
                  value={filters.scope}
                  onChange={(e) => setField('scope', e.target.value)}
                >
                  <option value="">Все каналы</option>
                  {CHAT_SCOPE_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </Select>
              </label>

              <label
                htmlFor={sourceFilterId}
                className="flex items-center gap-1.5 text-xs text-ink-3"
              >
                Источник
                <Select
                  id={sourceFilterId}
                  size="sm"
                  value={filters.source}
                  onChange={(e) => setField('source', e.target.value)}
                >
                  <option value="">Любой</option>
                  {CHAT_SOURCE_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </Select>
              </label>

              <label
                htmlFor={fromFilterId}
                className="flex items-center gap-1.5 text-xs text-ink-3"
              >
                С даты
                <TextInput
                  id={fromFilterId}
                  type="date"
                  size="sm"
                  value={filters.from}
                  onChange={(e) => setField('from', e.target.value)}
                />
              </label>

              <label htmlFor={toFilterId} className="flex items-center gap-1.5 text-xs text-ink-3">
                По дату
                <TextInput
                  id={toFilterId}
                  type="date"
                  size="sm"
                  value={filters.to}
                  onChange={(e) => setField('to', e.target.value)}
                />
              </label>
            </>
          }
          onReset={resetFilters}
          resetLabel="Сбросить"
          actions={
            <Button size="sm" variant="primary" onClick={() => apply(filters)}>
              Применить
            </Button>
          }
        />

        {error ? (
          <InlineBanner
            tone="crit"
            title="Не удалось загрузить историю чата"
            description={error}
            action={
              <Button size="sm" onClick={() => void load(applied)}>
                Повторить
              </Button>
            }
          />
        ) : null}

        {loading ? (
          <SkeletonTable rows={6} cols={5} label="Загрузка истории чата" />
        ) : messages.length === 0 ? (
          <EmptyState
            variant={filtersApplied ? 'filtered' : 'initial'}
            title={filtersApplied ? 'Нет сообщений по фильтру' : 'Сообщений нет'}
            description={
              filtersApplied
                ? 'Ни одно сообщение не подходит под выбранные фильтры.'
                : 'Панель ещё не записала ни одного сообщения этого игрока.'
            }
            action={
              filtersApplied ? (
                <Button size="sm" onClick={resetFilters}>
                  Сбросить фильтр
                </Button>
              ) : undefined
            }
          />
        ) : (
          <Table ariaLabel="История чата игрока">
            <TableHead sticky={false}>
              <tr>
                <Th>Время</Th>
                <Th>Сервер</Th>
                <Th>Канал</Th>
                <Th>Источник</Th>
                <Th>Сообщение</Th>
              </tr>
            </TableHead>
            <TableBody>
              {messages.map((message) => (
                <TableRow key={message.id}>
                  <Td className="whitespace-nowrap font-mono text-xs text-ink-3">
                    {formatDateTimeRu(message.sentAt, message.sentAt)}
                  </Td>
                  <Td className="text-ink-2">{serverName(message.serverId)}</Td>
                  <Td>
                    <Badge size="sm">{scopeLabel(message.scope)}</Badge>
                  </Td>
                  <Td className="text-ink-3">{sourceLabel(message.source)}</Td>
                  <Td>
                    <span className="whitespace-pre-wrap break-words">{message.message}</span>
                    {message.isFlagged ? (
                      <span className="ml-2 inline-block align-middle">
                        <Badge tone="crit" size="sm">
                          флаг
                        </Badge>
                      </span>
                    ) : null}
                  </Td>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}

        {nextCursor ? (
          <div className="flex justify-center">
            <Button size="sm" loading={busy} onClick={() => void loadMore()}>
              Показать ещё
            </Button>
          </div>
        ) : null}
      </CardBody>
    </Card>
  );
}
