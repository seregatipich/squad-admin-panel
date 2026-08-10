'use client';
import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { LiveIndicator } from '@/components/LiveIndicator';
import { PlayerMarkBadge } from '@/components/PlayerMarkBadge';
import { highestSeverityTone, type MarkTone, type MarkTypeMini } from '@/lib/marks';
import { useLiveSubscription } from '@/lib/use-live-bus';
import {
  buildPlayersListQuery,
  DEFAULT_SORT_STATE,
  nextSortState,
  type PlayerSortKey,
  type PlayerSortState,
  sortIndicator,
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

const rowToneClasses: Record<MarkTone, string> = {
  red: 'bg-red-950/25',
  amber: 'bg-amber-950/20',
  neutral: 'bg-neutral-800/30',
};

const SORT_INDICATOR: Record<OnlineSort, string> = {
  none: '↕',
  online: '↓',
  offline: '↑',
};

export default function PlayersPage() {
  const [data, setData] = useState<PlayersResponse | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [onlyOnline, setOnlyOnline] = useState(false);
  const [sortOnline, setSortOnline] = useState<OnlineSort>('none');
  const [sortState, setSortState] = useState<PlayerSortState>(DEFAULT_SORT_STATE);
  const [onlyNew, setOnlyNew] = useState(false);
  const [lastUpdate, setLastUpdate] = useState<Date | null>(null);
  const [markSummary, setMarkSummary] = useState<Record<string, MarkTypeMini[]>>({});
  const [onlineIds, setOnlineIds] = useState<Set<string>>(new Set());
  const [onlineLoaded, setOnlineLoaded] = useState(false);

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
    async function load() {
      try {
        const r = await fetch(`/api/v1/players?${listQuery}`, {
          credentials: 'include',
          cache: 'no-store',
        });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        if (!cancelled) {
          setData((await r.json()) as PlayersResponse);
          setErr(null);
          setLastUpdate(new Date());
        }
      } catch (e) {
        if (!cancelled) setErr((e as Error).message);
      }
    }
    void load();
    void loadMarkSummary();
    void loadOnlineStatus();
    const t = setInterval(() => {
      void load();
      void loadMarkSummary();
      void loadOnlineStatus();
    }, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(t);
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

  const onSort = useCallback((column: PlayerSortKey) => {
    setSortState((s) => nextSortState(s, column));
  }, []);

  if (!data && !err) return <div className="text-neutral-500">Загрузка…</div>;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold">Все игроки</h1>
        <div className="flex items-center gap-3">
          <div className="text-xs text-neutral-500">
            всего: {data?.total ?? 0} • онлайн сейчас: {onlineCount}
          </div>
          <LiveIndicator lastUpdate={lastUpdate} />
        </div>
      </div>

      {err ? (
        <div className="rounded border border-red-900 bg-red-950 p-3 text-sm">{err}</div>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        <input
          type="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Поиск по нику, SteamID или EOS ID…"
          className="flex-1 min-w-[260px] rounded border border-neutral-800 bg-neutral-950 px-3 py-1.5 text-sm"
        />
        <label className="flex items-center gap-2 text-xs text-neutral-400 cursor-pointer">
          <input
            type="checkbox"
            checked={onlyOnline}
            onChange={(e) => setOnlyOnline(e.target.checked)}
            className="accent-emerald-500"
          />
          только онлайн
        </label>
        <label className="flex items-center gap-2 text-xs text-neutral-400 cursor-pointer">
          <input
            type="checkbox"
            checked={onlyNew}
            onChange={(e) => setOnlyNew(e.target.checked)}
            className="accent-emerald-500"
          />
          новые (&lt;7 дней)
        </label>
      </div>

      {rows.length === 0 ? (
        <div className="rounded border border-neutral-800 bg-neutral-950 p-6 text-center text-neutral-500 text-sm">
          {data?.items.length
            ? 'Нет совпадений.'
            : 'Ни один игрок ещё не подключался. Запустите сервер и подключитесь в Squad-клиенте.'}
        </div>
      ) : (
        <div className="overflow-x-auto rounded border border-neutral-800">
          <table className="w-full text-sm">
            <thead className="bg-neutral-950 text-xs uppercase tracking-widest text-neutral-500">
              <tr>
                <th className="text-left p-2">
                  <button
                    type="button"
                    onClick={toggleSort}
                    aria-label="Сортировать по статусу онлайн"
                    className="inline-flex items-center gap-1 uppercase tracking-widest hover:text-neutral-300"
                  >
                    Статус
                    <span
                      className={sortOnline === 'none' ? 'text-neutral-600' : 'text-sky-400'}
                      aria-hidden="true"
                    >
                      {SORT_INDICATOR[sortOnline]}
                    </span>
                  </button>
                </th>
                <SortHeader label="Ник" column="nickname" state={sortState} onSort={onSort} />
                <th className="text-left p-2">SteamID64</th>
                <th className="text-left p-2">EOS ID</th>
                <SortHeader
                  label="Total playtime"
                  column="total_time"
                  state={sortState}
                  onSort={onSort}
                />
                <SortHeader label="Created" column="created" state={sortState} onSort={onSort} />
                <SortHeader
                  label="Last seen"
                  column="last_seen"
                  state={sortState}
                  onSort={onSort}
                />
              </tr>
            </thead>
            <tbody>
              {rows.map((p) => {
                const online = isOnline(p);
                const playerMarks = markSummary[p.id] ?? [];
                const markTone = highestSeverityTone(playerMarks);
                return (
                  <tr
                    key={p.id}
                    className={`border-t border-neutral-900 ${markTone ? rowToneClasses[markTone] : ''}`}
                  >
                    <td className="p-2">
                      <span className="inline-flex items-center gap-1.5">
                        <span
                          className={`inline-block h-2.5 w-2.5 rounded-full ${online ? 'bg-emerald-500' : 'bg-neutral-600'}`}
                          title={online ? 'online' : 'offline'}
                        />
                        <span
                          className={`text-xs ${online ? 'text-emerald-400' : 'text-neutral-600'}`}
                        >
                          {online ? 'онлайн' : 'офлайн'}
                        </span>
                      </span>
                    </td>
                    <td className="p-2">
                      <span className="inline-flex items-center gap-2">
                        <Link
                          href={`/all-players/${p.id}`}
                          className="text-sky-400 hover:text-sky-300 font-medium"
                        >
                          {p.canonical_name}
                        </Link>
                        <PlayerMarkBadge marks={playerMarks} />
                      </span>
                    </td>
                    <td className="p-2 font-mono text-xs">
                      {p.steam_id64 ? (
                        <a
                          href={`https://steamcommunity.com/profiles/${p.steam_id64}`}
                          target="_blank"
                          rel="noreferrer"
                          className="text-neutral-300 hover:text-sky-300"
                        >
                          {p.steam_id64}
                        </a>
                      ) : (
                        <span className="text-neutral-600">—</span>
                      )}
                    </td>
                    <td className="p-2 font-mono text-[11px] text-neutral-400">
                      {p.eos_id ?? '—'}
                    </td>
                    <td className="p-2 font-mono text-xs">
                      {fmtDuration(p.total_time_played_seconds)}
                    </td>
                    <td className="p-2 text-xs text-neutral-500">
                      {new Date(p.first_seen_at).toLocaleString()}
                    </td>
                    <td className="p-2 text-xs text-neutral-500">
                      {online ? (
                        <span className="text-emerald-400">сейчас на сервере</span>
                      ) : (
                        new Date(p.last_seen_at).toLocaleString()
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function SortHeader({
  label,
  column,
  state,
  onSort,
}: {
  label: string;
  column: PlayerSortKey;
  state: PlayerSortState;
  onSort: (column: PlayerSortKey) => void;
}) {
  return (
    <th className="text-left p-2">
      <button
        type="button"
        onClick={() => onSort(column)}
        aria-label={`Сортировать по колонке ${label}`}
        className="inline-flex items-center gap-1 uppercase tracking-widest hover:text-neutral-300"
      >
        {label}
        <span
          className={state.key === column ? 'text-sky-400' : 'text-neutral-600'}
          aria-hidden="true"
        >
          {sortIndicator(state, column)}
        </span>
      </button>
    </th>
  );
}

function fmtDuration(seconds: number): string {
  if (!seconds) return '0m';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h === 0) return `${m}m`;
  return `${h}h ${m}m`;
}
