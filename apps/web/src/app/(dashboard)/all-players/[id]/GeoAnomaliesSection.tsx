'use client';

import { useCallback, useEffect, useState } from 'react';
import { Badge, Button, InlineBanner, Skeleton, StatusBadge } from '@/components/ui';
import { CHART_FRAME, CHART_GRID, CHART_SURFACE } from '@/lib/chart-tokens';

interface CountrySwitch {
  from_country_code: string;
  from_country_name: string | null;
  to_country_code: string;
  to_country_name: string | null;
  from_observed_at: string;
  to_observed_at: string;
  gap_hours: number;
  within_window: boolean;
}

interface DistinctCountry {
  country_code: string;
  country_name: string | null;
  observation_count: number;
}

interface GeoPoint {
  ip: string;
  country_code: string | null;
  country_name: string | null;
  latitude: number;
  longitude: number;
  last_seen_at: string;
}

interface GeoAnomalies {
  config: { country_switch_window_hours: number; multi_country_threshold: number };
  distinct_country_count: number;
  multi_country: boolean;
  has_recent_switch: boolean;
  switches: CountrySwitch[];
  distinct_countries: DistinctCountry[];
  points: GeoPoint[];
}

/** Точки на карте: свежая — янтарная, остальные — синие; легенда рядом с картой. */
const POINT_LATEST = '#ff9f0a';
const POINT_TRAIL = '#409cff';

function flagEmoji(countryCode: string | null): string {
  if (!countryCode || countryCode.length !== 2) return '🏳️';
  const base = 0x1f1e6;
  const upper = countryCode.toUpperCase();
  const first = upper.charCodeAt(0) - 65;
  const second = upper.charCodeAt(1) - 65;
  if (first < 0 || first > 25 || second < 0 || second > 25) return '🏳️';
  return String.fromCodePoint(base + first) + String.fromCodePoint(base + second);
}

function formatGap(gapHours: number): string {
  if (gapHours < 1) return `${Math.round(gapHours * 60)} мин`;
  if (gapHours < 48) return `${Math.round(gapHours)} ч`;
  return `${Math.round(gapHours / 24)} дн`;
}

const CONTINENTS = [
  'M28,40 L58,26 L104,30 L120,52 L96,72 L70,70 L52,58 L30,56 Z',
  'M104,80 L128,74 L146,96 L138,132 L118,146 L106,120 L100,98 Z',
  'M168,26 L214,22 L222,40 L206,52 L178,52 L170,40 Z',
  'M164,58 L214,54 L232,86 L216,120 L192,128 L176,100 L162,74 Z',
  'M222,20 L300,14 L330,34 L322,68 L282,82 L244,72 L224,46 Z',
  'M292,104 L332,100 L340,120 L318,132 L296,124 Z',
];

function projectX(longitude: number): number {
  return longitude + 180;
}

function projectY(latitude: number): number {
  return 90 - latitude;
}

function WorldMap({ points }: { points: GeoPoint[] }) {
  const ordered = [...points].sort(
    (a, b) => Date.parse(a.last_seen_at) - Date.parse(b.last_seen_at),
  );
  const trail = ordered
    .map(
      (point) => `${projectX(point.longitude).toFixed(1)},${projectY(point.latitude).toFixed(1)}`,
    )
    .join(' ');
  const latestAt = ordered.length > 0 ? ordered[ordered.length - 1].last_seen_at : null;

  return (
    <svg
      viewBox="0 0 360 180"
      className="w-full rounded-ctl border border-line"
      role="img"
      aria-label="Карта локаций игрока"
      preserveAspectRatio="xMidYMid meet"
    >
      <title>Карта локаций игрока</title>
      {[30, 60, 90, 120, 150].map((y) => (
        <line key={`h${y}`} x1={0} y1={y} x2={360} y2={y} stroke={CHART_GRID} strokeWidth={0.4} />
      ))}
      {[60, 120, 180, 240, 300].map((x) => (
        <line key={`v${x}`} x1={x} y1={0} x2={x} y2={180} stroke={CHART_GRID} strokeWidth={0.4} />
      ))}
      <line x1={0} y1={90} x2={360} y2={90} stroke={CHART_FRAME} strokeWidth={0.6} />
      {CONTINENTS.map((path) => (
        <path key={path} d={path} fill={CHART_SURFACE} stroke={CHART_FRAME} strokeWidth={0.5} />
      ))}
      {ordered.length > 1 ? (
        <polyline
          points={trail}
          fill="none"
          stroke={POINT_TRAIL}
          strokeWidth={0.7}
          strokeDasharray="2 2"
          opacity={0.7}
        />
      ) : null}
      {ordered.map((point) => {
        const isLatest = point.last_seen_at === latestAt;
        return (
          <g key={`${point.ip}-${point.last_seen_at}`}>
            <circle
              cx={projectX(point.longitude)}
              cy={projectY(point.latitude)}
              r={isLatest ? 3.4 : 2.4}
              fill={isLatest ? POINT_LATEST : POINT_TRAIL}
              stroke={CHART_SURFACE}
              strokeWidth={0.6}
            >
              <title>{`${flagEmoji(point.country_code)} ${point.country_name ?? point.country_code ?? '—'} · ${point.ip}`}</title>
            </circle>
          </g>
        );
      })}
    </svg>
  );
}

export function GeoAnomaliesSection({ playerId }: { playerId: string }) {
  const [data, setData] = useState<GeoAnomalies | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetch(`/api/v1/players/${playerId}/geo-anomalies`, {
      credentials: 'include',
      cache: 'no-store',
    })
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))))
      .then((body: GeoAnomalies) => {
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

  if (loading) return <Skeleton variant="block" label="Загрузка гео-аномалий" />;
  if (error) {
    return (
      <InlineBanner
        tone="crit"
        title="Не удалось загрузить гео-аномалии"
        description={error}
        action={
          <Button size="sm" onClick={() => load()}>
            Повторить
          </Button>
        }
      />
    );
  }
  if (!data) return null;

  const recentSwitches = data.switches.filter((entry) => entry.within_window);
  const hasPoints = data.points.length > 0;

  return (
    <div className="space-y-4 border-t border-line pt-4">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-[13px] font-semibold text-ink">Гео-аномалии</h3>
        {data.multi_country ? (
          <span title={`Более ${data.config.multi_country_threshold} стран в истории IP`}>
            <StatusBadge
              state="warn"
              size="sm"
              label={`Мульти-страна (${data.distinct_country_count})`}
            />
          </span>
        ) : null}
        {data.has_recent_switch ? (
          <span title={`Смена страны за < ${data.config.country_switch_window_hours} ч`}>
            <StatusBadge
              state="crit"
              size="sm"
              label={`Смена страны менее чем за ${data.config.country_switch_window_hours} ч`}
            />
          </span>
        ) : null}
        {!data.multi_country && !data.has_recent_switch ? (
          <StatusBadge state="good" size="sm" label="Аномалий не обнаружено" />
        ) : null}
      </div>

      {hasPoints ? (
        <div className="max-w-xl">
          <WorldMap points={data.points} />
        </div>
      ) : null}

      {data.switches.length > 0 ? (
        <div className="space-y-2">
          <p className="text-2xs uppercase tracking-[0.06em] text-ink-3">
            Хронология смен ({data.switches.length})
          </p>
          <ul className="divide-y divide-line rounded-ctl border border-line">
            {[...data.switches]
              .sort((a, b) => Date.parse(b.to_observed_at) - Date.parse(a.to_observed_at))
              .map((entry) => (
                <li
                  key={`${entry.from_country_code}-${entry.to_country_code}-${entry.to_observed_at}`}
                  className={`flex flex-wrap items-center gap-2 px-3 py-2 text-[13px] ${
                    entry.within_window ? 'bg-crit/10' : ''
                  }`}
                >
                  <span className="inline-flex items-center gap-1">
                    <span aria-hidden="true">{flagEmoji(entry.from_country_code)}</span>
                    <span className="text-ink-2">
                      {entry.from_country_name ?? entry.from_country_code}
                    </span>
                  </span>
                  <span aria-hidden="true" className="text-ink-3">
                    →
                  </span>
                  <span className="inline-flex items-center gap-1">
                    <span aria-hidden="true">{flagEmoji(entry.to_country_code)}</span>
                    <span className="font-medium">
                      {entry.to_country_name ?? entry.to_country_code}
                    </span>
                  </span>
                  <span className="tabular-nums text-xs text-ink-3">
                    Δ {formatGap(entry.gap_hours)}
                  </span>
                  {entry.within_window ? (
                    <Badge size="sm" tone="crit">
                      Алерт
                    </Badge>
                  ) : null}
                  <span className="ml-auto text-xs text-ink-3">
                    {new Date(entry.to_observed_at).toLocaleString()}
                  </span>
                </li>
              ))}
          </ul>
          {recentSwitches.length > 0 ? (
            <p className="text-xs text-ink-3">
              Смена страны за менее чем {data.config.country_switch_window_hours} ч помечена как
              алерт.
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
