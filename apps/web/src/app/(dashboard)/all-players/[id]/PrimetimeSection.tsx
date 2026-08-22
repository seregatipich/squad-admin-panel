'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';

import { Badge, Button, InlineBanner, Skeleton } from '@/components/ui';
import { fmtDuration, MODE_HEX } from './presence';

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
/** Столбцы — обычные часы, пик — те же цвета, что у режимов присутствия. */
const BAR_COLOR = MODE_HEX.queue;
const PEAK_COLOR = MODE_HEX.boost;

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

  const load = useCallback(() => {
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

  useEffect(() => load(), [load]);

  const maxSeconds = useMemo(() => (data ? Math.max(1, ...data.histogram) : 1), [data]);

  if (error) {
    return (
      <InlineBanner
        tone="crit"
        title="Не удалось загрузить праймтайм"
        description={error}
        action={
          <Button size="sm" onClick={() => load()}>
            Повторить
          </Button>
        }
      />
    );
  }

  if (loading || !data) {
    return <Skeleton variant="card" label="Загрузка праймтайма" />;
  }

  const range = data.primetime;
  const tzLabel = data.timezone ?? `${offsetLabel(data.offset_minutes)} (по умолчанию)`;

  return (
    <div className="space-y-3 rounded-ctl border border-line p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-[13px] font-semibold text-ink">Праймтайм</h3>
        <span className="text-xs text-ink-3">
          Часовой пояс: <span className="text-ink-2">{tzLabel}</span>
        </span>
      </div>

      {range ? (
        <Badge tone="warn">{range.label}</Badge>
      ) : (
        <p className="text-xs text-ink-3">Недостаточно данных для расчёта праймтайма.</p>
      )}

      <div className="h-4 text-xs text-ink-2">
        {hoverHour !== null ? (
          <span className="tabular-nums">
            {String(hoverHour).padStart(2, '0')}:00–{String((hoverHour + 1) % 24).padStart(2, '0')}
            :00 · <span className="text-accent">{fmtDuration(data.histogram[hoverHour] ?? 0)}</span>
          </span>
        ) : (
          <span className="text-ink-3">Активность по часам суток за {data.window.days} дней</span>
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

      <div className="flex justify-between text-2xs tabular-nums text-ink-3">
        {[0, 6, 12, 18, 23].map((hour) => (
          <span key={hour}>{String(hour).padStart(2, '0')}</span>
        ))}
      </div>
    </div>
  );
}
