'use client';

import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { BanNickButton } from '@/components/BannedNameRuleModal';
import {
  Badge,
  type BadgeTone,
  Button,
  Card,
  Checkbox,
  EmptyState,
  InlineBanner,
  Modal,
  PageContainer,
  PageHeader,
  SearchField,
  SkeletonTable,
  Table,
  TableBody,
  TableHead,
  TableRow,
  Td,
  Th,
  Toolbar,
  type ToolbarProps,
} from '@/components/ui';
import { apiFetch, describeHttpError } from '@/lib/api';
import type { LiveEvent } from '@/lib/live-bus';
import { useLiveSubscription } from '@/lib/use-live-bus';
import { useApiResource } from '@/lib/use-polled-resource';
import {
  apiItemToRow,
  buildApiQuery,
  buildQueryString,
  CHAT_SCOPES,
  type ChatApiItem,
  type ChatFilters,
  type ChatRow,
  type ChatScope,
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

/**
 * Тон пилюли канала.
 *
 * `helpers.ts` хранит для каждого канала готовую строку классов, но это общий
 * модуль со своим владельцем; здесь канал переводится в тон дизайн-системы.
 * Цвет только различает соседние категории (§5) — смысл несёт подпись.
 */
const NO_SERVERS: ServerOption[] = [];

const SCOPE_TONE: Record<ChatScope, BadgeTone> = {
  all: 'accent',
  team: 'good',
  squad: 'warn',
  admin: 'crit',
  broadcast: 'accent',
  direct: 'neutral',
};

/** Пилюля команды: два соседних значения должны различаться, не более того. */
const TEAM_TONE: Record<number, BadgeTone> = { 1: 'accent', 2: 'warn' };

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
  const [drawerOpen, setDrawerOpen] = useState(false);
  // Tracks the most recently started load()/loadMore() request; a response is
  // applied only if it is still the current one, so a filter change (a new
  // load()) can never be clobbered by a slower loadMore() (or an even older
  // load()) that resolves after it — see finding #504.
  const requestIdRef = useRef(0);

  const serversResource = useApiResource<{ items?: ServerOption[] }>('/api/v1/servers');
  const servers = serversResource.data?.items ?? NO_SERVERS;

  // BANNAME-3 — derives the «Забанить ник» button's visibility the same way
  // servers/[id]/page.tsx does: from the squad `ban` permission on /api/v1/me.
  const meResource = useApiResource<{ squad_permissions?: string[] }>('/api/v1/me');
  const canBan = meResource.data?.squad_permissions?.includes('ban') ?? false;

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

  const load = useCallback(async () => {
    const requestId = ++requestIdRef.current;
    setLoading(true);
    setError(null);
    setLiveRows([]);
    try {
      const data = await apiFetch<ChatListResponse>(
        `/api/v1/chat/messages?${buildApiQuery(filters)}`,
      );
      if (requestIdRef.current !== requestId) return;
      setPageRows(data.items.map(apiItemToRow));
      setCursor(data.next_cursor);
    } catch (err) {
      if (requestIdRef.current !== requestId) return;
      setError(describeHttpError(err));
      setPageRows([]);
      setCursor(null);
    } finally {
      if (requestIdRef.current === requestId) setLoading(false);
    }
  }, [filters]);

  useEffect(() => {
    void load();
  }, [load]);

  const loadMore = useCallback(async () => {
    if (!cursor) return;
    const requestId = ++requestIdRef.current;
    setLoadingMore(true);
    try {
      const data = await apiFetch<ChatListResponse>(
        `/api/v1/chat/messages?${buildApiQuery(filters, cursor)}`,
      );
      if (requestIdRef.current !== requestId) return;
      setPageRows((prev) => [...prev, ...data.items.map(apiItemToRow)]);
      setCursor(data.next_cursor);
    } catch (err) {
      if (requestIdRef.current !== requestId) return;
      setError(describeHttpError(err));
    } finally {
      if (requestIdRef.current === requestId) setLoadingMore(false);
    }
  }, [cursor, filters]);

  const onChat = useCallback(
    (event: Extract<LiveEvent, { type: 'chat.message' }>) => {
      if (!liveOn) return;
      const row = liveMessageToRow(event.data);
      if (!liveRowMatchesFilters(row, filters)) return;
      setLiveRows((prev) => prependLiveRow(prev, row));
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

  const filtersApplied = hasActiveFilters(filters);
  const resetFilters = useCallback(() => navigate(EMPTY_FILTERS), [navigate]);
  const resetProps: ToolbarProps = filtersApplied
    ? { onReset: resetFilters, resetLabel: 'Сбросить фильтр' }
    : {};

  const filterPanel = (
    <FilterSidebar
      filters={filters}
      servers={servers}
      liveAvailable={liveAvailable}
      liveEnabled={liveEnabled}
      onToggleLive={() => setLiveEnabled((value) => !value)}
      onChange={navigate}
    />
  );

  return (
    <PageContainer>
      <PageHeader
        title="Чат"
        subtitle="Глобальный архив внутриигрового чата всех серверов: поиск по игроку и тексту, фильтры по серверам, каналам и дате. Бродкасты админов идут вперемешку с сообщениями игроков."
      />

      <Toolbar
        search={
          <SearchField
            value={filters.text}
            onCommit={(next) => navigate({ text: next.trim() })}
            label="Поиск по тексту сообщений"
            placeholder="Текст сообщения"
            clearLabel="Очистить поиск"
          />
        }
        filters={
          <Button className="md:hidden" onClick={() => setDrawerOpen(true)}>
            Фильтры
          </Button>
        }
        {...resetProps}
        summary={rows.length > 0 ? `Показано ${rows.length}` : undefined}
      />

      <div className="flex gap-6">
        <aside className="hidden w-72 shrink-0 md:block">{filterPanel}</aside>

        <section className="min-w-0 flex-1 space-y-4">
          {error ? (
            <InlineBanner
              tone="crit"
              title="Не удалось загрузить чат"
              description={error}
              action={
                <Button size="sm" onClick={() => void load()}>
                  Повторить
                </Button>
              }
            />
          ) : null}

          <Card padding="none">
            {loading ? (
              <div className="p-3">
                <SkeletonTable rows={8} cols={6} label="Загружаем архив чата" />
              </div>
            ) : rows.length === 0 ? (
              <EmptyState
                variant={filtersApplied ? 'filtered' : 'initial'}
                title={filtersApplied ? 'Ничего не нашлось' : 'Сообщений пока нет'}
                description={
                  filtersApplied
                    ? 'Ни одно сообщение не подходит под запрос и выбранные фильтры.'
                    : 'Как только игроки напишут в чат, сообщения появятся здесь.'
                }
                action={
                  filtersApplied ? <Button onClick={resetFilters}>Сбросить фильтр</Button> : null
                }
              />
            ) : (
              <>
                <Table ariaLabel="Сообщения чата">
                  <TableHead>
                    <TableRow>
                      <Th>Время</Th>
                      <Th>Сервер</Th>
                      <Th>Команда</Th>
                      <Th>Игрок</Th>
                      <Th>Канал</Th>
                      <Th>Сообщение</Th>
                      {canBan ? <Th align="right">Действия</Th> : null}
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {rows.map((row) => (
                      <ChatTableRow
                        key={row.key}
                        row={row}
                        serverName={serverNames.get(row.serverId)}
                        canBan={canBan}
                      />
                    ))}
                  </TableBody>
                </Table>

                {cursor ? (
                  <div className="flex justify-center border-t border-line p-3">
                    <Button onClick={() => void loadMore()} loading={loadingMore}>
                      Показать ещё
                    </Button>
                  </div>
                ) : null}
              </>
            )}
          </Card>
        </section>
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
        {filterPanel}
      </Modal>
    </PageContainer>
  );
}

function ChatTableRow({
  row,
  serverName,
  canBan,
}: {
  row: ChatRow;
  serverName: string | undefined;
  canBan: boolean;
}) {
  const scope = scopeMeta(row.scope);
  const team = teamFlagMeta(row.teamId);
  const href = playerHref(row);
  return (
    <TableRow interactive className="align-top">
      <Td className="whitespace-nowrap font-mono text-2xs text-ink-3">
        {formatArchiveTime(row.sentAt)}
      </Td>
      <Td className="whitespace-nowrap text-xs text-ink-2">
        {serverName ?? `${row.serverId.slice(0, 8)}…`}
      </Td>
      <Td>
        {team ? (
          <Badge size="sm" tone={TEAM_TONE[row.teamId ?? 0] ?? 'neutral'}>
            {team.label}
          </Badge>
        ) : (
          <span className="text-ink-4">—</span>
        )}
      </Td>
      <Td className="whitespace-nowrap">
        {href ? (
          <Link href={href} className="font-medium text-accent no-underline hover:brightness-110">
            {row.nickname}
          </Link>
        ) : (
          <span className="font-medium text-ink-2">{row.nickname}</span>
        )}
      </Td>
      <Td>
        <Badge size="sm" tone={SCOPE_TONE[row.scope]}>
          <span aria-hidden>{scope.icon}</span>
          {scope.labelRu}
        </Badge>
      </Td>
      <Td className="break-words text-ink">
        {row.isFlagged ? (
          <Badge size="sm" tone="crit" title="Помечено фильтром чата">
            флаг
          </Badge>
        ) : null}{' '}
        {row.message}
      </Td>
      {canBan ? (
        <Td align="right" className="whitespace-nowrap">
          <BanNickButton nick={row.nickname} canBan={canBan} />
        </Td>
      ) : null}
    </TableRow>
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
  return (
    <Card className="space-y-4">
      <div className="space-y-1.5">
        <span className="block text-xs font-medium text-ink-2">Игрок</span>
        <SearchField
          value={filters.playerQuery}
          onCommit={(next) => onChange({ playerQuery: next.trim() })}
          label="Поиск игрока (ник, SteamID64 или EOS ID)"
          placeholder="Ник, SteamID64 или EOS ID"
          clearLabel="Очистить поиск игрока"
        />
      </div>

      <div className="space-y-1.5">
        <span className="block text-xs font-medium text-ink-2">Каналы</span>
        <div className="space-y-1">
          {CHAT_SCOPES.map((scope) => (
            <Checkbox
              key={scope}
              label={
                <span className="inline-flex items-center gap-1">
                  <span aria-hidden>{SCOPE_META[scope].icon}</span>
                  {SCOPE_META[scope].labelRu}
                </span>
              }
              checked={filters.scopes.includes(scope)}
              onChange={() => onChange({ scopes: toggleValue(filters.scopes, scope) })}
            />
          ))}
        </div>
      </div>

      {servers.length > 0 ? (
        <div className="space-y-1.5">
          <span className="block text-xs font-medium text-ink-2">Серверы</span>
          <div className="space-y-1">
            {servers.map((server) => (
              <Checkbox
                key={server.id}
                label={<span className="truncate">{server.display_name}</span>}
                checked={filters.serverIds.includes(server.id)}
                onChange={() => onChange({ serverIds: toggleValue(filters.serverIds, server.id) })}
              />
            ))}
          </div>
        </div>
      ) : null}

      <div className="grid grid-cols-2 gap-2">
        <label className="flex flex-col gap-1 text-xs text-ink-2">
          С даты
          <input
            type="date"
            value={filters.from}
            onChange={(event) => onChange({ from: event.target.value })}
            className="h-8 w-full rounded-ctl border border-line bg-raised px-2 text-xs text-ink"
          />
        </label>
        <label className="flex flex-col gap-1 text-xs text-ink-2">
          По дату
          <input
            type="date"
            value={filters.to}
            onChange={(event) => onChange({ to: event.target.value })}
            className="h-8 w-full rounded-ctl border border-line bg-raised px-2 text-xs text-ink"
          />
        </label>
      </div>

      <div className="space-y-2 border-t border-line pt-3">
        <Checkbox
          label="Только помеченные фильтром"
          checked={filters.flaggedOnly}
          onChange={(event) => onChange({ flaggedOnly: event.target.checked })}
        />
        <Checkbox
          label="Живой поток"
          checked={liveEnabled && liveAvailable}
          disabled={!liveAvailable}
          onChange={onToggleLive}
        />
        {!liveAvailable ? (
          <p className="text-xs text-ink-3">
            Живой поток недоступен при фильтре по дате — очистите даты, чтобы получать новые
            сообщения.
          </p>
        ) : null}
      </div>
    </Card>
  );
}
