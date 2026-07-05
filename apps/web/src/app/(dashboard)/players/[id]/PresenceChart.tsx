'use client';

import { useEffect, useMemo, useState } from 'react';

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

export function PresenceChart({ playerId }: { playerId: string }) {
  const [range, setRange] = useState<DailyRange>(30);
  const [data, setData] = useState<DailyPresenceResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
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

  const bars = useMemo(() => (data ? buildDailyBars(data.series, data.from, data.to) : []), [data]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="text-xs uppercase tracking-widest text-neutral-500">Онлайн по дням</div>
          <LiveBadge live={data?.live ?? null} />
        </div>
        <div className="flex items-center gap-1">
          {DAILY_RANGES.map((preset) => (
            <button
              key={preset}
              type="button"
              onClick={() => setRange(preset)}
              className={`rounded border px-2 py-0.5 text-xs ${
                range === preset
                  ? 'border-sky-500 bg-sky-950/40 text-sky-300'
                  : 'border-neutral-800 text-neutral-400 hover:border-neutral-600'
              }`}
            >
              {DAILY_RANGE_LABELS[preset]}
            </button>
          ))}
        </div>
      </div>

      <PlaytimeCard totalSeconds={data?.total_time_played_seconds ?? 0} />

      {error ? (
        <div className="rounded border border-red-900 bg-red-950 p-2 text-xs text-red-200">
          Ошибка: {error}
        </div>
      ) : loading || !data ? (
        <div className="text-sm text-neutral-500">Загрузка…</div>
      ) : (
        <DailyBarChart bars={bars} />
      )}
    </div>
  );
}

function PlaytimeCard({ totalSeconds }: { totalSeconds: number }) {
  return (
    <div className="rounded border border-neutral-800 bg-neutral-900/40 p-3">
      <div className="text-xs uppercase tracking-widest text-neutral-500">Онлайн</div>
      <div className="mt-1 font-mono text-2xl text-emerald-300">{fmtDuration(totalSeconds)}</div>
      <div className="text-[11px] text-neutral-500 tabular-nums">
        {totalSeconds.toLocaleString('ru-RU')} сек · всего наиграно
      </div>
    </div>
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
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full border border-neutral-800 bg-neutral-950/80 px-2 py-0.5 text-[10px] text-neutral-500">
        <span className="inline-block h-1.5 w-1.5 rounded-full bg-neutral-600" />
        Оффлайн
      </span>
    );
  }

  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-900 bg-emerald-950/40 px-2 py-0.5 text-[10px] text-emerald-300">
      <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-green-500" />
      Онлайн · <span className="tabular-nums">{liveElapsedLabel(sinceMs, now)}</span>
    </span>
  );
}

function DailyBarChart({ bars }: { bars: DailyBar[] }) {
  const [selected, setSelected] = useState<number | null>(null);

  if (bars.length === 0) {
    return (
      <div className="rounded border border-dashed border-neutral-800 p-6 text-center text-sm text-neutral-500">
        Нет данных о присутствии за период.
      </div>
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
      <div className="h-4 text-[11px] text-neutral-400">
        {active ? (
          <span className="tabular-nums">
            {active.day} ·{' '}
            <span className="text-emerald-300">{fmtDuration(active.total_seconds)}</span>
            {active.boost_seconds > 0 ? ` · буст ${fmtDuration(active.boost_seconds)}` : ''}
            {active.queue_seconds > 0 ? ` · очередь ${fmtDuration(active.queue_seconds)}` : ''}
          </span>
        ) : (
          <span className="text-neutral-600">Наведите на столбец для точных чисел</span>
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
                stroke="#262626"
                strokeWidth="0.5"
              />
              <text x={PAD.left - 4} y={y + 3} textAnchor="end" fontSize="9" fill="#737373">
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
          stroke="#404040"
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
              fill="#737373"
            >
              {bar.day.slice(5)}
            </text>
          ) : null,
        )}
      </svg>
    </div>
  );
}
