'use client';

import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import { formatCount, formatDuration, medalFor, shouldNavigateRow } from '../helpers';
import {
  BONUS_PERIODS,
  type BonusLeaderboardBody,
  type BonusPeriod,
  buildApiQuery,
  buildQueryString,
  parsePeriod,
  playerHref,
  valueColumnLabel,
} from './helpers';

export default function BonusLeaderboardPage() {
  return (
    <Suspense fallback={<div className="text-neutral-500">Загрузка…</div>}>
      <BonusLeaderboardBrowser />
    </Suspense>
  );
}

function BonusLeaderboardBrowser() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const period = useMemo(() => parsePeriod(searchParams), [searchParams]);

  const [data, setData] = useState<BonusLeaderboardBody | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const selectPeriod = useCallback(
    (next: BonusPeriod) => {
      const qs = buildQueryString(next);
      router.replace(qs ? `${pathname}?${qs}` : pathname);
    },
    [pathname, router],
  );

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetch(`/api/v1/leaderboards/bonuses?${buildApiQuery(period)}`, {
      credentials: 'include',
      cache: 'no-store',
    })
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return (await res.json()) as BonusLeaderboardBody;
      })
      .then((body) => {
        if (!cancelled) setData(body);
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
  }, [period]);

  const openPlayer = useCallback(
    (playerId: string, event: React.MouseEvent) => {
      const target = event.target as HTMLElement;
      if (target.closest('a')) return;
      const selection = typeof window !== 'undefined' ? window.getSelection()?.toString() : '';
      const allowed = shouldNavigateRow({
        ctrlKey: event.ctrlKey,
        metaKey: event.metaKey,
        altKey: event.altKey,
        shiftKey: event.shiftKey,
        hasSelection: Boolean(selection),
      });
      if (!allowed) return;
      router.push(`/all-players/${playerId}`);
    },
    [router],
  );

  const rows = data?.rows ?? [];
  const available = data?.available ?? true;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold">Лидерборд бонусов</h1>
        <div className="flex items-center gap-1">
          {BONUS_PERIODS.map((entry) => (
            <button
              key={entry.value}
              type="button"
              onClick={() => selectPeriod(entry.value)}
              className={`rounded px-2 py-1 text-xs ${
                period === entry.value
                  ? 'bg-neutral-800 text-neutral-100'
                  : 'text-neutral-400 hover:text-neutral-200'
              }`}
            >
              {entry.label}
            </button>
          ))}
        </div>
      </div>

      {error ? (
        <div className="rounded border border-red-900 bg-red-950 p-3 text-sm text-red-200">
          Ошибка загрузки: {error}
        </div>
      ) : null}

      {!available && !loading ? (
        <div className="rounded border border-dashed border-neutral-800 py-12 text-center text-sm text-neutral-400">
          Экономика отключена — лидерборд бонусов недоступен.
        </div>
      ) : (
        <BonusTable period={period} rows={rows} loading={loading} onOpenPlayer={openPlayer} />
      )}

      {available ? (
        <div className="text-xs text-neutral-500">Всего: {formatCount(data?.total_rows ?? 0)}</div>
      ) : null}
    </div>
  );
}

function BonusTable({
  period,
  rows,
  loading,
  onOpenPlayer,
}: {
  period: BonusPeriod;
  rows: BonusLeaderboardBody['rows'];
  loading: boolean;
  onOpenPlayer: (playerId: string, event: React.MouseEvent) => void;
}) {
  if (loading && rows.length === 0) {
    return <div className="py-10 text-center text-sm text-neutral-500">Загрузка…</div>;
  }
  if (!loading && rows.length === 0) {
    return (
      <div className="rounded border border-dashed border-neutral-800 py-12 text-center text-sm text-neutral-400">
        Пока никто не заработал бонусов.
      </div>
    );
  }

  return (
    <div className="overflow-x-auto rounded border border-neutral-800">
      <table className="w-full min-w-[560px] text-sm">
        <thead className="bg-neutral-950 text-xs uppercase tracking-wider text-neutral-500">
          <tr>
            <th className="p-2 text-right">#</th>
            <th className="p-2 text-left">Игрок</th>
            <th className="p-2 text-right">{valueColumnLabel(period)}</th>
            <th className="p-2 text-right">Онлайн</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const medal = medalFor(row.rank);
            return (
              <tr
                key={row.player_id}
                onClick={(event) => onOpenPlayer(row.player_id, event)}
                className="cursor-pointer border-t border-neutral-900 hover:bg-neutral-900/40"
              >
                <td className="p-2 text-right font-mono text-xs text-neutral-400">
                  {medal ? <span className="text-base">{medal}</span> : row.rank}
                </td>
                <td className="p-2 text-left">
                  <a
                    href={playerHref(row)}
                    className="font-medium text-sky-400 hover:text-sky-300"
                    onClick={(event) => event.stopPropagation()}
                  >
                    {row.current_name}
                  </a>
                </td>
                <td className="p-2 text-right font-mono text-xs">{formatCount(row.value)}</td>
                <td className="p-2 text-right font-mono text-xs">
                  {formatDuration(row.online_seconds)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
