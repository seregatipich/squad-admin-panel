'use client';

import { useEffect, useMemo, useState } from 'react';

import { fmtDuration } from './presence';

interface PrimetimeRange {
  label: string;
  start_minutes: number;
  end_minutes: number;
  start_hour: number;
  end_hour: number;
}

interface PrimetimeResponse {
  window: { from: string; to: string; days: number };
  timezone: string | null;
  offset_minutes: number;
  total_seconds: number;
  histogram: number[];
  rolling_average: number[];
  primetime: PrimetimeRange | null;
}

const HOURS = Array.from({ length: 24 }, (_, hour) => hour);
const BAR_COLOR = '#38bdf8';
const PEAK_COLOR = '#f59e0b';

function offsetLabel(offsetMinutes: number): string {
  const sign = offsetMinutes < 0 ? '-' : '+';
  const abs = Math.abs(offsetMinutes);
  const hours = String(Math.floor(abs / 60)).padStart(2, '0');
  const minutes = String(abs % 60).padStart(2, '0');
  return `UTC${sign}${hours}:${minutes}`;
}

function isPeakHour(hour: number, range: PrimetimeRange | null): boolean {
  if (!range) return false;
  const { start_hour: start, end_hour: end } = range;
  if (start <= end) return hour >= start && hour <= end;
  return hour >= start || hour <= end;
}

export function PrimetimeSection({ playerId }: { playerId: string }) {
  const [data, setData] = useState<PrimetimeResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [hoverHour, setHoverHour] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetch(`/api/v1/players/${playerId}/primetime`, { credentials: 'include', cache: 'no-store' })
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))))
      .then((body: PrimetimeResponse) => {
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
  }, [playerId]);

  const maxSeconds = useMemo(() => (data ? Math.max(1, ...data.histogram) : 1), [data]);

  if (error) {
    return (
      <div className="rounded border border-red-900 bg-red-950 p-2 text-xs text-red-200">
        Праймтайм — ошибка: {error}
      </div>
    );
  }

  if (loading || !data) {
    return <div className="text-sm text-neutral-500">Загрузка праймтайма…</div>;
  }

  const range = data.primetime;
  const tzLabel = data.timezone ?? `${offsetLabel(data.offset_minutes)} (по умолчанию)`;

  return (
    <div className="space-y-3 rounded border border-neutral-800 bg-neutral-900/40 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="text-xs uppercase tracking-widest text-neutral-500">Праймтайм</div>
        <span className="text-[11px] text-neutral-500">
          Часовой пояс: <span className="text-neutral-400">{tzLabel}</span>
        </span>
      </div>

      {range ? (
        <div className="inline-flex items-center gap-2 rounded-full border border-amber-900 bg-amber-950/40 px-3 py-1">
          <span
            className="inline-block h-2 w-2 rounded-full"
            style={{ backgroundColor: PEAK_COLOR }}
          />
          <span className="font-mono text-sm text-amber-200">{range.label}</span>
        </div>
      ) : (
        <div className="text-sm text-neutral-500">Недостаточно данных для расчёта праймтайма.</div>
      )}

      <div className="h-4 text-[11px] text-neutral-400">
        {hoverHour !== null ? (
          <span className="tabular-nums">
            {String(hoverHour).padStart(2, '0')}:00–{String((hoverHour + 1) % 24).padStart(2, '0')}
            :00 ·{' '}
            <span className="text-sky-300">{fmtDuration(data.histogram[hoverHour] ?? 0)}</span>
          </span>
        ) : (
          <span className="text-neutral-600">
            Активность по часам суток за {data.window.days} дней
          </span>
        )}
      </div>

      <div className="flex items-end gap-px" style={{ height: 88 }}>
        {HOURS.map((hour) => {
          const seconds = data.histogram[hour] ?? 0;
          const heightPct = (seconds / maxSeconds) * 100;
          const peak = isPeakHour(hour, range);
          return (
            <button
              type="button"
              key={hour}
              onMouseEnter={() => setHoverHour(hour)}
              onMouseLeave={() => setHoverHour(null)}
              onFocus={() => setHoverHour(hour)}
              onBlur={() => setHoverHour(null)}
              title={`${String(hour).padStart(2, '0')}:00 — ${fmtDuration(seconds)}`}
              aria-label={`${String(hour).padStart(2, '0')}:00 — ${fmtDuration(seconds)}`}
              className="flex flex-1 items-end self-stretch rounded-sm bg-transparent"
            >
              <span
                className="w-full rounded-sm transition-opacity"
                style={{
                  height: `${Math.max(seconds > 0 ? 3 : 0, heightPct)}%`,
                  backgroundColor: peak ? PEAK_COLOR : BAR_COLOR,
                  opacity: hoverHour === null || hoverHour === hour ? 0.9 : 0.45,
                }}
              />
            </button>
          );
        })}
      </div>

      <div className="flex justify-between text-[10px] tabular-nums text-neutral-600">
        {[0, 6, 12, 18, 23].map((hour) => (
          <span key={hour}>{String(hour).padStart(2, '0')}</span>
        ))}
      </div>
    </div>
  );
}
