'use client';

import { useEffect, useState } from 'react';

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
      className="w-full rounded border border-neutral-800 bg-neutral-900/40"
      role="img"
      aria-label="Карта локаций игрока"
      preserveAspectRatio="xMidYMid meet"
    >
      <title>Карта локаций игрока</title>
      {[30, 60, 90, 120, 150].map((y) => (
        <line key={`h${y}`} x1={0} y1={y} x2={360} y2={y} stroke="#1f2937" strokeWidth={0.4} />
      ))}
      {[60, 120, 180, 240, 300].map((x) => (
        <line key={`v${x}`} x1={x} y1={0} x2={x} y2={180} stroke="#1f2937" strokeWidth={0.4} />
      ))}
      <line x1={0} y1={90} x2={360} y2={90} stroke="#334155" strokeWidth={0.6} />
      {CONTINENTS.map((path) => (
        <path key={path} d={path} fill="#1e293b" stroke="#334155" strokeWidth={0.5} />
      ))}
      {ordered.length > 1 ? (
        <polyline
          points={trail}
          fill="none"
          stroke="#38bdf8"
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
              fill={isLatest ? '#f59e0b' : '#38bdf8'}
              stroke="#0f172a"
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

  useEffect(() => {
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

  if (loading) return <div className="text-sm text-neutral-500">Загрузка аномалий…</div>;
  if (error) {
    return (
      <div className="rounded border border-red-900 bg-red-950 p-2 text-xs text-red-200">
        Ошибка гео-аномалий: {error}
      </div>
    );
  }
  if (!data) return null;

  const recentSwitches = data.switches.filter((entry) => entry.within_window);
  const hasPoints = data.points.length > 0;

  return (
    <div className="space-y-4 border-t border-neutral-800 pt-4">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-[11px] uppercase tracking-widest text-neutral-400">Гео-аномалии</h3>
        {data.multi_country ? (
          <span
            title={`Более ${data.config.multi_country_threshold} стран в истории IP`}
            className="inline-flex items-center gap-1.5 rounded border border-amber-800 bg-amber-950/60 px-2 py-0.5 text-[10px] uppercase tracking-wide text-amber-300"
          >
            <span className="h-1.5 w-1.5 rounded-full bg-amber-400" />
            Мульти-страна ({data.distinct_country_count})
          </span>
        ) : null}
        {data.has_recent_switch ? (
          <span
            title={`Смена страны за < ${data.config.country_switch_window_hours} ч`}
            className="inline-flex items-center gap-1.5 rounded border border-red-900 bg-red-950/60 px-2 py-0.5 text-[10px] uppercase tracking-wide text-red-300"
          >
            <span className="h-1.5 w-1.5 rounded-full bg-red-500" />
            Смена страны &lt;{data.config.country_switch_window_hours}ч
          </span>
        ) : null}
        {!data.multi_country && !data.has_recent_switch ? (
          <span className="text-xs text-neutral-600">аномалий не обнаружено</span>
        ) : null}
      </div>

      {hasPoints ? (
        <div className="max-w-xl">
          <WorldMap points={data.points} />
        </div>
      ) : null}

      {data.switches.length > 0 ? (
        <div className="space-y-2">
          <div className="text-[10px] uppercase tracking-widest text-neutral-500">
            Хронология смен ({data.switches.length})
          </div>
          <ul className="space-y-1.5">
            {[...data.switches]
              .sort((a, b) => Date.parse(b.to_observed_at) - Date.parse(a.to_observed_at))
              .map((entry) => (
                <li
                  key={`${entry.from_country_code}-${entry.to_country_code}-${entry.to_observed_at}`}
                  className={`flex flex-wrap items-center gap-2 rounded border px-2 py-1 text-sm ${
                    entry.within_window
                      ? 'border-red-900/70 bg-red-950/40'
                      : 'border-neutral-800 bg-neutral-900/40'
                  }`}
                >
                  <span className="inline-flex items-center gap-1">
                    <span>{flagEmoji(entry.from_country_code)}</span>
                    <span className="text-neutral-300">
                      {entry.from_country_name ?? entry.from_country_code}
                    </span>
                  </span>
                  <span className="text-neutral-600">→</span>
                  <span className="inline-flex items-center gap-1">
                    <span>{flagEmoji(entry.to_country_code)}</span>
                    <span className="font-medium">
                      {entry.to_country_name ?? entry.to_country_code}
                    </span>
                  </span>
                  <span className="font-mono text-xs text-neutral-500">
                    Δ {formatGap(entry.gap_hours)}
                  </span>
                  {entry.within_window ? (
                    <span className="rounded bg-red-950 px-1.5 py-0.5 text-[10px] uppercase text-red-300">
                      алерт
                    </span>
                  ) : null}
                  <span className="ml-auto text-xs text-neutral-600">
                    {new Date(entry.to_observed_at).toLocaleString()}
                  </span>
                </li>
              ))}
          </ul>
          {recentSwitches.length > 0 ? (
            <p className="text-[11px] text-neutral-600">
              Смена страны за менее чем {data.config.country_switch_window_hours} ч помечена как
              алерт.
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
