'use client';
import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { PlayerMarkBadge } from '@/components/PlayerMarkBadge';
import {
  Button,
  Card,
  Checkbox,
  DateTime,
  EmptyState,
  InlineBanner,
  PageContainer,
  PageHeader,
  Pagination,
  SearchField,
  SkeletonTable,
  SortableTh,
  type SortDirection,
  StatusDot,
  Table,
  TableBody,
  TableHead,
  TableRow,
  type TableRowTone,
  Td,
  Th,
  Toolbar,
} from '@/components/ui';
import { useIntlLocale } from '@/i18n/LocaleProvider';
import { highestSeverityTone, type MarkTone, type MarkTypeMini } from '@/lib/marks';
import { useLiveSubscription } from '@/lib/use-live-bus';
import { useApiResource } from '@/lib/use-polled-resource';
import { fmtDuration } from './[id]/presence';
import {
  buildPlayersListQuery,
  DEFAULT_SORT_STATE,
  nextSortState,
  PLAYERS_PAGE_SIZE,
  type PlayerSortKey,
  type PlayerSortState,
} from './helpers';

interface Player {
  id: string;
  steam_id64: string | null;
  canonical_name: string;
  eos_id: string | null;
  first_seen_at: string;
  last_seen_at: string;
  total_time_played_seconds: number;
}

interface PlayersResponse {
  items: Player[];
  total: number;
}

type OnlineSort = 'none' | 'online' | 'offline';

const POLL_MS = 8000;
/** Fallback online heuristic used until the open-session status has loaded. */
const ONLINE_WINDOW_MS = 90_000;

/**
 * Метка игрока подкрашивает строку. Цвет здесь — только ускоритель просмотра:
 * что именно за метка, говорит бейдж в колонке ника, поэтому у строки без
 * подсветки (`neutral`) ничего не теряется (дизайн-система, §5).
 */
const ROW_TONE: Record<MarkTone, TableRowTone> = {
  red: 'crit',
  amber: 'warn',
  neutral: 'default',
};

/** Как читается направление сортировки колонок с обычными значениями. */
const SORT_DIRECTION_TEXT: Record<SortDirection, string> = {
  asc: 'по возрастанию',
  desc: 'по убыванию',
};

/**
 * У колонки состояния «возрастание» бессмысленно: сортируют не число, а то,
 * кто сейчас на сервере, — поэтому направление называется словами.
 */
const ONLINE_DIRECTION_TEXT: Record<SortDirection, string> = {
  desc: 'сначала онлайн',
  asc: 'сначала офлайн',
};

/** Колонка состояния сортируется тремя состояниями, `SortableTh` — двумя. */
const ONLINE_SORT_DIRECTION: Record<Exclude<OnlineSort, 'none'>, SortDirection> = {
  online: 'desc',
  offline: 'asc',
};

export default function PlayersPage() {
  const locale = useIntlLocale();
  const [q, setQ] = useState('');
  const [onlyOnline, setOnlyOnline] = useState(false);
  const [sortOnline, setSortOnline] = useState<OnlineSort>('none');
  const [sortState, setSortState] = useState<PlayerSortState>(DEFAULT_SORT_STATE);
  const [onlyNew, setOnlyNew] = useState(false);
  const [page, setPage] = useState(1);
  const listQuery = buildPlayersListQuery(sortState, onlyNew, page, q);
  const players = useApiResource<PlayersResponse>(`/api/v1/players?${listQuery}`, {
    intervalMs: POLL_MS,
  });
  const online = useApiResource<{ online_player_ids: string[] }>('/api/v1/players/online-status', {
    intervalMs: POLL_MS,
  });
  // The mark summary doesn't need the 8s poll: it's loaded once and kept
  // current by the mark.changed live subscription below (#489).
  const marks = useApiResource<{
    items: Array<{ player_id: string; marks: MarkTypeMini[] }>;
  }>('/api/v1/marks/active-summary');

  // The hook drops its data when the query changes; the previous page stays on
  // screen until the new one arrives, so a keystroke in the search box does
  // not flash the skeleton.
  const [data, setData] = useState<PlayersResponse | null>(null);
  useEffect(() => {
    if (players.data) setData(players.data);
  }, [players.data]);
  const err = players.errorMessage;

  const markSummary = useMemo(() => {
    const next: Record<string, MarkTypeMini[]> = {};
    for (const item of marks.data?.items ?? []) next[item.player_id] = item.marks;
    return next;
  }, [marks.data]);

  const onlineLoaded = online.data !== undefined;
  const onlineIds = useMemo(() => new Set(online.data?.online_player_ids), [online.data]);

  const refreshAll = () => {
    void players.refresh();
    void online.refresh();
  };

  const pageCount = data ? Math.max(1, Math.ceil(data.total / PLAYERS_PAGE_SIZE)) : 1;

  const refreshMarks = marks.refresh;
  const onMarkChanged = useCallback(() => {
    void refreshMarks();
  }, [refreshMarks]);
  useLiveSubscription('mark.changed', onMarkChanged);

  const isOnline = useCallback(
    (p: Player) =>
      onlineLoaded
        ? onlineIds.has(p.id)
        : Date.now() - new Date(p.last_seen_at).getTime() <= ONLINE_WINDOW_MS,
    [onlineLoaded, onlineIds],
  );

  const rows = useMemo(() => {
    if (!data) return [];
    // The search text is already applied server-side via `q` (#485) — the
    // items here are exactly the server's matches, including a name-history
    // match whose canonical_name may not itself contain the query. Only
    // "только онлайн" and the online/offline sort remain client-side.
    const filtered = onlyOnline ? data.items.filter((p) => isOnline(p)) : data.items;
    if (sortOnline === 'none') return filtered;
    const onlineFirst = sortOnline === 'online';
    return [...filtered].sort((a, b) => {
      const ao = isOnline(a) ? 1 : 0;
      const bo = isOnline(b) ? 1 : 0;
      if (ao === bo) return 0;
      return onlineFirst ? bo - ao : ao - bo;
    });
  }, [data, onlyOnline, sortOnline, isOnline]);

  // Counts every online player the panel knows about, not just those on the
  // server's (at most 200-row, possibly search-filtered) current page (#485).
  const onlineCount = onlineLoaded
    ? onlineIds.size
    : (data?.items.filter((p) => isOnline(p)).length ?? 0);

  const toggleSort = useCallback(() => {
    setSortOnline((s) => (s === 'none' ? 'online' : s === 'online' ? 'offline' : 'none'));
  }, []);

  const onSort = useCallback((column: string) => {
    setSortState((s) => nextSortState(s, column as PlayerSortKey));
    setPage(1);
  }, []);

  const filtersApplied = q.trim() !== '' || onlyOnline || onlyNew;

  return (
    <PageContainer>
      <PageHeader
        title="Все игроки"
        meta={
          <>
            <span>всего: {data?.total ?? 0}</span>
            <span>онлайн сейчас: {onlineCount}</span>
          </>
        }
      />

      {err ? (
        <InlineBanner
          tone="crit"
          title="Не удалось загрузить список игроков"
          description={err}
          action={
            <Button size="sm" onClick={refreshAll}>
              Повторить
            </Button>
          }
        />
      ) : null}

      <Toolbar
        search={
          <SearchField
            value={q}
            onCommit={(value) => {
              setQ(value);
              setPage(1);
            }}
            label="Поиск по игрокам"
            placeholder="Поиск по нику, SteamID или EOS ID…"
            clearLabel="Очистить поиск"
          />
        }
        filters={
          <>
            <Checkbox
              label="только онлайн"
              checked={onlyOnline}
              onChange={(e) => setOnlyOnline(e.target.checked)}
            />
            <Checkbox
              label="новые (<7 дней)"
              checked={onlyNew}
              onChange={(e) => {
                setOnlyNew(e.target.checked);
                setPage(1);
              }}
            />
          </>
        }
        summary={data ? `показано: ${rows.length}` : undefined}
      />

      <Card padding="none">
        {data === null ? (
          err ? null : (
            <div className="p-3">
              <SkeletonTable rows={8} cols={7} label="Загрузка списка игроков" />
            </div>
          )
        ) : rows.length === 0 ? (
          <EmptyState
            variant={filtersApplied ? 'filtered' : 'initial'}
            title={filtersApplied ? 'Нет совпадений.' : 'Пока никто не подключался'}
            description={
              filtersApplied
                ? 'Ни один игрок не подходит под запрос и включённые фильтры.'
                : 'Ни один игрок ещё не подключался. Запустите сервер и подключитесь в Squad-клиенте.'
            }
          />
        ) : (
          <Table ariaLabel="Все игроки">
            <TableHead>
              <tr>
                <SortableTh
                  sortKey="online"
                  activeKey={sortOnline === 'none' ? null : 'online'}
                  direction={sortOnline === 'none' ? 'desc' : ONLINE_SORT_DIRECTION[sortOnline]}
                  onSort={toggleSort}
                  label="Статус"
                  directionText={ONLINE_DIRECTION_TEXT}
                />
                <SortableTh
                  sortKey="nickname"
                  activeKey={sortState.key}
                  direction={sortState.dir}
                  onSort={onSort}
                  label="Ник"
                  directionText={SORT_DIRECTION_TEXT}
                />
                <Th>SteamID64</Th>
                <Th>EOS ID</Th>
                <SortableTh
                  sortKey="total_time"
                  activeKey={sortState.key}
                  direction={sortState.dir}
                  onSort={onSort}
                  label="Наиграно"
                  directionText={SORT_DIRECTION_TEXT}
                  align="right"
                />
                <SortableTh
                  sortKey="created"
                  activeKey={sortState.key}
                  direction={sortState.dir}
                  onSort={onSort}
                  label="Создан"
                  directionText={SORT_DIRECTION_TEXT}
                />
                <SortableTh
                  sortKey="last_seen"
                  activeKey={sortState.key}
                  direction={sortState.dir}
                  onSort={onSort}
                  label="Был(а)"
                  directionText={SORT_DIRECTION_TEXT}
                />
              </tr>
            </TableHead>
            <TableBody>
              {rows.map((p) => {
                const online = isOnline(p);
                const playerMarks = markSummary[p.id] ?? [];
                const markTone = highestSeverityTone(playerMarks);
                return (
                  <TableRow key={p.id} interactive tone={markTone ? ROW_TONE[markTone] : 'default'}>
                    <Td>
                      <StatusDot
                        state={online ? 'good' : 'idle'}
                        label={online ? 'онлайн' : 'офлайн'}
                      />
                    </Td>
                    <Td>
                      <span className="inline-flex items-center gap-2">
                        <Link
                          href={`/all-players/${p.id}`}
                          className="font-medium text-accent no-underline hover:brightness-110"
                        >
                          {p.canonical_name}
                        </Link>
                        <PlayerMarkBadge marks={playerMarks} />
                      </span>
                    </Td>
                    <Td className="font-mono text-xs">
                      {p.steam_id64 ? (
                        <a
                          href={`https://steamcommunity.com/profiles/${p.steam_id64}`}
                          target="_blank"
                          rel="noreferrer"
                          className="text-ink-2 no-underline hover:text-accent"
                        >
                          {p.steam_id64}
                        </a>
                      ) : (
                        <span className="text-ink-3">—</span>
                      )}
                    </Td>
                    <Td className="font-mono text-2xs text-ink-3">{p.eos_id ?? '—'}</Td>
                    <Td numeric className="font-mono text-xs">
                      {fmtDuration(p.total_time_played_seconds)}
                    </Td>
                    <Td className="text-xs text-ink-3">
                      <DateTime value={p.first_seen_at} locale={locale} />
                    </Td>
                    <Td className="text-xs text-ink-3">
                      {online ? (
                        <span className="text-good">сейчас на сервере</span>
                      ) : (
                        <DateTime value={p.last_seen_at} locale={locale} />
                      )}
                    </Td>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </Card>

      {pageCount > 1 ? (
        <div className="flex justify-end">
          <Pagination
            page={page}
            pageCount={pageCount}
            onChange={setPage}
            allowJump
            labels={{
              previous: 'Назад',
              next: 'Вперёд',
              page: (current, of) => `Стр. ${current} из ${of}`,
            }}
          />
        </div>
      ) : null}
    </PageContainer>
  );
}
