'use client';
import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
import {
  buildPlayersListQuery,
  DEFAULT_SORT_STATE,
  nextSortState,
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
  const [data, setData] = useState<PlayersResponse | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [onlyOnline, setOnlyOnline] = useState(false);
  const [sortOnline, setSortOnline] = useState<OnlineSort>('none');
  const [sortState, setSortState] = useState<PlayerSortState>(DEFAULT_SORT_STATE);
  const [onlyNew, setOnlyNew] = useState(false);
  const [markSummary, setMarkSummary] = useState<Record<string, MarkTypeMini[]>>({});
  const [onlineIds, setOnlineIds] = useState<Set<string>>(new Set());
  const [onlineLoaded, setOnlineLoaded] = useState(false);
  /**
   * Внеочередное обновление по кнопке «Повторить».
   *
   * Ссылка, а не второй путь загрузки: опрос обязан остаться единственным
   * местом, которое пишет `data`, — иначе ответ на отменённый запрос обгонит
   * актуальный и вернёт на экран список, отсортированный по прошлой колонке.
   */
  const refreshRef = useRef<() => void>(() => {});

  const loadMarkSummary = useCallback(async () => {
    try {
      const r = await fetch('/api/v1/marks/active-summary', {
        credentials: 'include',
        cache: 'no-store',
      });
      if (!r.ok) return;
      const body = (await r.json()) as {
        items: Array<{ player_id: string; marks: MarkTypeMini[] }>;
      };
      const next: Record<string, MarkTypeMini[]> = {};
      for (const item of body.items) next[item.player_id] = item.marks;
      setMarkSummary(next);
    } catch {
      /* keep the previous summary on transient failures */
    }
  }, []);

  const loadOnlineStatus = useCallback(async () => {
    try {
      const r = await fetch('/api/v1/players/online-status', {
        credentials: 'include',
        cache: 'no-store',
      });
      if (!r.ok) return;
      const body = (await r.json()) as { online_player_ids: string[] };
      setOnlineIds(new Set(body.online_player_ids));
      setOnlineLoaded(true);
    } catch {
      /* keep the previous online set on transient failures */
    }
  }, []);

  const listQuery = buildPlayersListQuery(sortState, onlyNew);

  useEffect(() => {
    let cancelled = false;
    async function loadPlayers() {
      try {
        const r = await fetch(`/api/v1/players?${listQuery}`, {
          credentials: 'include',
          cache: 'no-store',
        });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        if (!cancelled) {
          setData((await r.json()) as PlayersResponse);
          setErr(null);
        }
      } catch (e) {
        if (!cancelled) setErr((e as Error).message);
      }
    }
    const refresh = () => {
      void loadPlayers();
      void loadMarkSummary();
      void loadOnlineStatus();
    };
    refreshRef.current = refresh;
    refresh();
    const t = setInterval(refresh, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(t);
      refreshRef.current = () => {};
    };
  }, [loadMarkSummary, loadOnlineStatus, listQuery]);

  const onMarkChanged = useCallback(() => {
    void loadMarkSummary();
  }, [loadMarkSummary]);
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
    const needle = q.trim().toLowerCase();
    const filtered = data.items.filter((p) => {
      if (onlyOnline && !isOnline(p)) return false;
      if (!needle) return true;
      return (
        p.canonical_name.toLowerCase().includes(needle) ||
        (p.steam_id64 ?? '').includes(needle) ||
        (p.eos_id ?? '').toLowerCase().includes(needle)
      );
    });
    if (sortOnline === 'none') return filtered;
    const onlineFirst = sortOnline === 'online';
    return [...filtered].sort((a, b) => {
      const ao = isOnline(a) ? 1 : 0;
      const bo = isOnline(b) ? 1 : 0;
      if (ao === bo) return 0;
      return onlineFirst ? bo - ao : ao - bo;
    });
  }, [data, q, onlyOnline, sortOnline, isOnline]);

  const onlineCount = useMemo(
    () => (data ? data.items.filter((p) => isOnline(p)).length : 0),
    [data, isOnline],
  );

  const toggleSort = useCallback(() => {
    setSortOnline((s) => (s === 'none' ? 'online' : s === 'online' ? 'offline' : 'none'));
  }, []);

  const onSort = useCallback((column: string) => {
    setSortState((s) => nextSortState(s, column as PlayerSortKey));
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
            <Button size="sm" onClick={() => refreshRef.current()}>
              Повторить
            </Button>
          }
        />
      ) : null}

      <Toolbar
        search={
          <SearchField
            value={q}
            onCommit={setQ}
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
              onChange={(e) => setOnlyNew(e.target.checked)}
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
    </PageContainer>
  );
}

function fmtDuration(seconds: number): string {
  if (!seconds) return '0m';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h === 0) return `${m}m`;
  return `${h}h ${m}m`;
}
