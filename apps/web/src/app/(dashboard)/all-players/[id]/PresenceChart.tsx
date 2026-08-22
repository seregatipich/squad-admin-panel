'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';

import {
  Button,
  EmptyState,
  InlineBanner,
  SegmentedControl,
  Skeleton,
  StatTile,
  StatusDot,
} from '@/components/ui';
import { CHART_AXIS, CHART_FRAME, CHART_GRID } from '@/lib/chart-tokens';
import { fmtDuration, MODE_HEX } from './presence';
import {
  buildDailyBars,
  DAILY_RANGE_LABELS,
  DAILY_RANGES,
  type DailyBar,
  type DailyPresenceResponse,
  type DailyRange,
  liveElapsedLabel,
  maxTotalSeconds,
  niceHourMax,
} from './presence-chart';

const VIEW_W = 720;
const VIEW_H = 200;
const PAD = { top: 12, right: 8, bottom: 22, left: 34 };
const INNER_W = VIEW_W - PAD.left - PAD.right;
const INNER_H = VIEW_H - PAD.top - PAD.bottom;
const Y_TICKS = [0, 0.25, 0.5, 0.75, 1];

const RANGE_ITEMS = DAILY_RANGES.map((preset) => ({
  value: String(preset),
  label: DAILY_RANGE_LABELS[preset],
}));

export function PresenceChart({ playerId }: { playerId: string }) {
  const [range, setRange] = useState<DailyRange>(30);
  const [data, setData] = useState<DailyPresenceResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetch(`/api/v1/players/${playerId}/presence/daily?range=${range}`, {
      credentials: 'include',
      cache: 'no-store',
    })
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))))
      .then((body: DailyPresenceResponse) => {
        if (!cancelled) setData(body);
      })
      .catch((e) => {
        if (!cancelled) setError((e as Error).message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [playerId, range]);

  useEffect(() => load(), [load]);

  const bars = useMemo(() => (data ? buildDailyBars(data.series, data.from, data.to) : []), [data]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <h3 className="text-[13px] font-semibold text-ink">Онлайн по дням</h3>
          <LiveBadge live={data?.live ?? null} />
        </div>
        <SegmentedControl
          ariaLabel="Период графика онлайна"
          size="sm"
          items={RANGE_ITEMS}
          value={String(range)}
          onChange={(value) => setRange(Number(value) as DailyRange)}
        />
      </div>

      <PlaytimeCard totalSeconds={data?.total_time_played_seconds ?? 0} />

      {error ? (
        <InlineBanner
          tone="crit"
          title="Не удалось загрузить онлайн по дням"
          description={error}
          action={
            <Button size="sm" onClick={() => load()}>
              Повторить
            </Button>
          }
        />
      ) : loading || !data ? (
        <Skeleton variant="card" label="Загрузка онлайна по дням" />
      ) : (
        <DailyBarChart bars={bars} />
      )}
    </div>
  );
}

function PlaytimeCard({ totalSeconds }: { totalSeconds: number }) {
  return (
    <StatTile
      label="Наиграно"
      value={fmtDuration(totalSeconds)}
      hint={`${totalSeconds.toLocaleString('ru-RU')} сек всего`}
    />
  );
}

function LiveBadge({ live }: { live: DailyPresenceResponse['live'] | null }) {
  const [now, setNow] = useState<number>(() => Date.now());
  const sinceMs = live?.since ? Date.parse(live.since) : null;

  useEffect(() => {
    if (!live?.online || sinceMs === null) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [live?.online, sinceMs]);

  if (!live?.online || sinceMs === null) {
    return <StatusDot state="idle" size="sm" label="Оффлайн" />;
  }

  // Пульсация здесь означает ровно одно: счётчик идёт прямо сейчас (§9).
  return (
    <StatusDot state="good" size="sm" pulse label={`Онлайн · ${liveElapsedLabel(sinceMs, now)}`} />
  );
}

function DailyBarChart({ bars }: { bars: DailyBar[] }) {
  const [selected, setSelected] = useState<number | null>(null);

  if (bars.length === 0) {
    return (
      <EmptyState
        title="Данных за период нет"
        description="Нет данных о присутствии за выбранный период."
      />
    );
  }

  const maxSeconds = maxTotalSeconds(bars);
  const hourMax = niceHourMax(maxSeconds);
  const yMaxSeconds = hourMax * 3600;
  const slot = INNER_W / bars.length;
  const barWidth = Math.max(1, slot * 0.72);
  const yScale = (seconds: number) => INNER_H - (seconds / yMaxSeconds) * INNER_H;
  const labelStep = Math.max(1, Math.ceil(bars.length / 6));
  const active = selected !== null ? bars[selected] : null;

  const selectFromPointer = (event: React.PointerEvent<SVGSVGElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    if (rect.width === 0) return;
    const viewBoxX = ((event.clientX - rect.left) / rect.width) * VIEW_W;
    const plotX = viewBoxX - PAD.left;
    if (plotX < 0 || plotX > INNER_W) {
      setSelected(null);
      return;
    }
    setSelected(Math.min(bars.length - 1, Math.max(0, Math.floor(plotX / slot))));
  };

  return (
    <div className="space-y-2">
      <div className="h-4 text-xs text-ink-2">
        {active ? (
          <span className="tabular-nums">
            {active.day} · <span className="text-good">{fmtDuration(active.total_seconds)}</span>
            {active.boost_seconds > 0 ? ` · буст ${fmtDuration(active.boost_seconds)}` : ''}
            {active.queue_seconds > 0 ? ` · очередь ${fmtDuration(active.queue_seconds)}` : ''}
          </span>
        ) : (
          <span className="text-ink-3">Наведите на столбец для точных чисел</span>
        )}
      </div>

      <svg
        viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
        className="w-full touch-none"
        role="img"
        aria-label="График онлайна по дням"
        onPointerMove={selectFromPointer}
        onPointerDown={selectFromPointer}
        onPointerLeave={() => setSelected(null)}
      >
        <title>Онлайн по дням</title>
        {Y_TICKS.map((frac) => {
          const y = PAD.top + INNER_H - frac * INNER_H;
          return (
            <g key={frac}>
              <line
                x1={PAD.left}
                y1={y}
                x2={PAD.left + INNER_W}
                y2={y}
                stroke={CHART_GRID}
                strokeWidth="0.5"
              />
              <text x={PAD.left - 4} y={y + 3} textAnchor="end" fontSize="9" fill={CHART_AXIS}>
                {Math.round(frac * hourMax)}ч
              </text>
            </g>
          );
        })}

        {selected !== null ? (
          <rect
            x={PAD.left + selected * slot}
            y={PAD.top}
            width={slot}
            height={INNER_H}
            fill="#ffffff"
            opacity={0.04}
            pointerEvents="none"
          />
        ) : null}

        {bars.map((bar, index) => {
          if (bar.total_seconds === 0) return null;
          const x = PAD.left + index * slot + (slot - barWidth) / 2;
          const barTop = PAD.top + yScale(bar.total_seconds);
          const height = Math.max(0, PAD.top + INNER_H - barTop);
          return (
            <rect
              key={bar.day}
              x={x}
              y={barTop}
              width={barWidth}
              height={height}
              rx={barWidth > 4 ? 1 : 0}
              fill={MODE_HEX.online}
              opacity={index === selected ? 1 : 0.82}
              pointerEvents="none"
            />
          );
        })}

        <line
          x1={PAD.left}
          y1={PAD.top + INNER_H}
          x2={PAD.left + INNER_W}
          y2={PAD.top + INNER_H}
          stroke={CHART_FRAME}
          strokeWidth="1"
        />

        {bars.map((bar, index) =>
          index % labelStep === 0 ? (
            <text
              key={`lbl-${bar.day}`}
              x={PAD.left + index * slot + slot / 2}
              y={VIEW_H - 6}
              textAnchor="middle"
              fontSize="9"
              fill={CHART_AXIS}
            >
              {bar.day.slice(5)}
            </text>
          ) : null,
        )}
      </svg>
    </div>
  );
}
