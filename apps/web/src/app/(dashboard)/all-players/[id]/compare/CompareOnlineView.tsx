'use client';

import { useEffect, useMemo, useState } from 'react';

import { type PickedPlayer, PlayerSearchSelect } from '../../../issues/PlayerSearchSelect';
import { fmtDuration, utcDayKey, weekStartMsForEndDay } from '../presence';
import { SteamFriendCheck } from '../SteamFriendCheck';
import {
  buildCompareWeekGrid,
  type CompareOnlineResponse,
  cellStyle,
  cellTitle,
  nextWeekEndDay,
  prevWeekEndDay,
  summaryLabel,
} from './compare-online';

const HOURS = Array.from({ length: 24 }, (_, hour) => hour);
const WEEKDAY_LABELS = ['Вс', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб'];

function dayRowLabel(dayKey: string): string {
  const ms = Date.parse(`${dayKey}T00:00:00.000Z`);
  if (!Number.isFinite(ms)) return dayKey;
  const weekday = WEEKDAY_LABELS[new Date(ms).getUTCDay()] ?? '';
  return `${weekday} ${dayKey.slice(5)}`;
}

export function CompareOnlineView({
  playerId,
  initialOther,
}: {
  playerId: string;
  initialOther?: string;
}) {
  const [other, setOther] = useState<PickedPlayer | null>(
    initialOther ? { id: initialOther, canonical_name: initialOther } : null,
  );
  const [endDay, setEndDay] = useState<string>(() => utcDayKey(Date.now()));
  const [data, setData] = useState<CompareOnlineResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [hidden, setHidden] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!other) {
      setData(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setHidden(false);
    setError(null);
    const from = utcDayKey(weekStartMsForEndDay(endDay));
    const params = new URLSearchParams({ other: other.id, from, to: endDay });
    fetch(`/api/v1/players/${playerId}/compare-online?${params.toString()}`, {
      credentials: 'include',
      cache: 'no-store',
    })
      .then(async (res) => {
        if (res.status === 401 || res.status === 403) {
          setHidden(true);
          return null;
        }
        if (!res.ok) {
          const body = (await res.json().catch(() => null)) as { error?: string } | null;
          throw new Error(body?.error ?? `HTTP ${res.status}`);
        }
        return (await res.json()) as CompareOnlineResponse;
      })
      .then((body) => {
        if (!cancelled && body) setData(body);
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
  }, [playerId, other, endDay]);

  // Sync the picker label with the real canonical name once it's known — a
  // deep-linked `initialOther` id has no name until the first response.
  useEffect(() => {
    if (!data) return;
    const [, playerB] = data.players;
    setOther((prev) =>
      prev && prev.id === playerB.id && prev.canonical_name !== playerB.canonical_name
        ? { id: playerB.id, canonical_name: playerB.canonical_name }
        : prev,
    );
  }, [data]);

  const grid = useMemo(() => {
    if (!data) return null;
    return buildCompareWeekGrid(
      data.sessions.a,
      data.sessions.b,
      weekStartMsForEndDay(data.window.to),
      Date.now(),
    );
  }, [data]);

  if (hidden) return null;

  return (
    <section className="rounded border border-neutral-800 bg-neutral-950 p-4 space-y-4">
      <h2 className="text-xs uppercase tracking-widest text-neutral-400">Сравнение онлайна</h2>

      <div className="max-w-sm">
        <PlayerSearchSelect
          placeholder="Найти второго игрока…"
          onSelect={(player) => setOther(player)}
        />
        {other ? (
          <div className="mt-2 flex items-center gap-2 text-xs text-neutral-300">
            Игрок B:{' '}
            <span className="rounded bg-neutral-800 px-1.5 py-0.5 text-neutral-100">
              {other.canonical_name}
            </span>
            <SteamFriendCheck key={other.id} playerId={playerId} otherPlayerId={other.id} />
            <button
              type="button"
              onClick={() => setOther(null)}
              className="text-neutral-500 hover:text-neutral-300"
            >
              ✕
            </button>
          </div>
        ) : null}
      </div>

      {!other ? (
        <div className="rounded border border-dashed border-neutral-800 p-6 text-center text-sm text-neutral-500">
          Выберите второго игрока, чтобы сравнить онлайн.
        </div>
      ) : error ? (
        <div className="rounded border border-red-900 bg-red-950 p-2 text-xs text-red-200">
          Ошибка: {error}
        </div>
      ) : loading || !data || !grid ? (
        <div className="text-sm text-neutral-500">Загрузка…</div>
      ) : (
        <>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setEndDay((prev) => prevWeekEndDay(prev))}
                className="rounded border border-neutral-800 px-2 py-1 text-xs text-neutral-300 hover:border-neutral-600"
              >
                ← Пред. неделя
              </button>
              <button
                type="button"
                onClick={() => setEndDay((prev) => nextWeekEndDay(prev))}
                className="rounded border border-neutral-800 px-2 py-1 text-xs text-neutral-300 hover:border-neutral-600"
              >
                След. неделя →
              </button>
            </div>
            <span className="text-[11px] text-neutral-500">
              Неделя (UTC): {data.window.from} — {data.window.to}
            </span>
          </div>

          <div className="flex flex-wrap items-center gap-4 text-[11px] text-neutral-400">
            <span className="flex items-center gap-1">
              <span
                className="inline-block h-2.5 w-2.5 rounded-sm"
                style={{ backgroundColor: '#409cff' }}
              />
              Игрок A ({data.players[0].canonical_name})
            </span>
            <span className="flex items-center gap-1">
              <span
                className="inline-block h-2.5 w-2.5 rounded-sm"
                style={{ backgroundColor: '#ff9f0a' }}
              />
              Игрок B ({data.players[1].canonical_name})
            </span>
            <span className="flex items-center gap-1">
              <span
                className="inline-block h-2.5 w-2.5 rounded-sm"
                style={{ backgroundColor: '#30d158' }}
              />
              Совместно
            </span>
          </div>

          <div className="overflow-x-auto">
            <div className="min-w-[720px] text-[10px] text-neutral-500">
              <div
                className="grid gap-px"
                style={{ gridTemplateColumns: '56px repeat(24, minmax(14px, 1fr))' }}
              >
                <div />
                {HOURS.map((hour) => (
                  <div key={hour} className="text-center tabular-nums">
                    {hour % 3 === 0 ? hour : ''}
                  </div>
                ))}
              </div>

              {grid.days.map((dayKey, dayIndex) => (
                <div
                  key={dayKey}
                  className="mt-px grid gap-px"
                  style={{ gridTemplateColumns: '56px repeat(24, minmax(14px, 1fr))' }}
                >
                  <div className="flex items-center pr-1 text-neutral-400 whitespace-nowrap">
                    {dayRowLabel(dayKey)}
                  </div>
                  {HOURS.map((hour) => {
                    const cell = grid.cells[dayIndex]?.[hour];
                    if (!cell) return <div key={hour} className="h-5" />;
                    const style = cellStyle(cell);
                    return (
                      <div
                        key={hour}
                        role="img"
                        title={cellTitle(cell, dayKey)}
                        aria-label={cellTitle(cell, dayKey)}
                        className={`h-5 rounded-sm ${style ? '' : 'bg-neutral-900/50'}`}
                        style={style}
                      />
                    );
                  })}
                </div>
              ))}
            </div>
          </div>

          <div className="rounded border border-neutral-800 bg-neutral-900/40 p-3 text-sm text-neutral-200">
            {summaryLabel(data.overlap.total_seconds, data.overlap.concurrent_count)}
            <span className="ml-2 text-[11px] text-neutral-500">
              ({fmtDuration(data.overlap.total_seconds)})
            </span>
          </div>
        </>
      )}
    </section>
  );
}
