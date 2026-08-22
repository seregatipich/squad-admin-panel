'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';

import {
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  CloseIcon,
  EmptyState,
  IconButton,
  InlineBanner,
  Skeleton,
} from '@/components/ui';
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
const GRID_COLUMNS = '56px repeat(24, minmax(14px, 1fr))';

/** Цвета легенды повторяют заливку ячеек из {@link cellStyle}. */
const LEGEND = [
  { color: '#409cff', label: 'Игрок A' },
  { color: '#ff9f0a', label: 'Игрок B' },
  { color: '#30d158', label: 'Совместно' },
];

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

  const load = useCallback(() => {
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

  useEffect(() => load(), [load]);

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
    <Card padding="none" as="section">
      <CardHeader
        title="Второй игрок"
        actions={
          data && grid ? (
            <>
              <Button size="sm" onClick={() => setEndDay((prev) => prevWeekEndDay(prev))}>
                Пред. неделя
              </Button>
              <Button size="sm" onClick={() => setEndDay((prev) => nextWeekEndDay(prev))}>
                След. неделя
              </Button>
            </>
          ) : undefined
        }
      />
      <CardBody className="space-y-4">
        <div className="max-w-sm">
          <PlayerSearchSelect
            placeholder="Найти второго игрока…"
            onSelect={(player) => setOther(player)}
          />
          {other ? (
            <div className="mt-2 flex items-center gap-2 text-xs text-ink-2">
              Игрок B:
              <Badge>{other.canonical_name}</Badge>
              <SteamFriendCheck key={other.id} playerId={playerId} otherPlayerId={other.id} />
              <IconButton
                size="sm"
                icon={<CloseIcon />}
                label="Убрать второго игрока"
                onClick={() => setOther(null)}
              />
            </div>
          ) : null}
        </div>

        {!other ? (
          <EmptyState
            title="Второй игрок не выбран"
            description="Выберите второго игрока, чтобы сравнить онлайн."
          />
        ) : error ? (
          <InlineBanner
            tone="crit"
            title="Не удалось сравнить онлайн"
            description={error}
            action={
              <Button size="sm" onClick={() => load()}>
                Повторить
              </Button>
            }
          />
        ) : loading || !data || !grid ? (
          <Skeleton variant="card" label="Загрузка сравнения онлайна" />
        ) : (
          <>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex flex-wrap items-center gap-4 text-2xs text-ink-2">
                {LEGEND.map((entry, index) => (
                  <span key={entry.label} className="flex items-center gap-1">
                    <span
                      aria-hidden="true"
                      className="inline-block h-2.5 w-2.5 rounded-sm"
                      style={{ backgroundColor: entry.color }}
                    />
                    {index < 2
                      ? `${entry.label} (${data.players[index]?.canonical_name ?? '—'})`
                      : entry.label}
                  </span>
                ))}
              </div>
              <span className="text-xs text-ink-3">
                Неделя (UTC): {data.window.from} — {data.window.to}
              </span>
            </div>

            <div className="overflow-x-auto">
              <div className="min-w-[720px] text-2xs text-ink-3">
                <div className="grid gap-px" style={{ gridTemplateColumns: GRID_COLUMNS }}>
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
                    style={{ gridTemplateColumns: GRID_COLUMNS }}
                  >
                    <div className="flex items-center whitespace-nowrap pr-1 text-ink-2">
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
                          className={`h-5 rounded-sm ${style ? '' : 'bg-raised'}`}
                          style={style}
                        />
                      );
                    })}
                  </div>
                ))}
              </div>
            </div>

            <p className="rounded-ctl border border-line p-3 text-[13px] text-ink">
              {summaryLabel(data.overlap.total_seconds, data.overlap.concurrent_count)}
              <span className="ml-2 text-xs text-ink-3">
                ({fmtDuration(data.overlap.total_seconds)})
              </span>
            </p>
          </>
        )}
      </CardBody>
    </Card>
  );
}
