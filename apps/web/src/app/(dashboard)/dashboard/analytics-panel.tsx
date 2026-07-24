'use client';
import { useCallback, useEffect, useId, useState } from 'react';
import {
  buildAnalyticsQuery,
  type DashboardAnalytics,
  formatDurationRu,
  formatHour,
  formatHours,
  outcomeSegments,
  peakScale,
  WINDOW_PRESETS,
  windowRange,
} from './analytics-data';

interface ServerOption {
  id: string;
  display_name: string;
}

const OUTCOME_FILL: Record<string, string> = {
  team1: 'bg-sky-500',
  team2: 'bg-emerald-500',
  draw: 'bg-amber-500',
  unknown: 'bg-neutral-600',
};

const AXIS_HOURS = [0, 6, 12, 18];

export function AnalyticsPanel({ servers }: { servers: ServerOption[] }) {
  const [serverId, setServerId] = useState<string>('');
  const [windowDays, setWindowDays] = useState<number>(WINDOW_PRESETS[0].days);
  const [data, setData] = useState<DashboardAnalytics | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const serverSelectId = useId();
  const windowSelectId = useId();

  // `windowRange()` reads the current clock. Computing it during render makes the
  // server-rendered HTML and the first client render disagree (the CSV href carries a
  // `to=<now>` timestamp), which React reports as a hydration mismatch. Defer the clock
  // read to after mount so the initial markup is deterministic.
  const [range, setRange] = useState<{ from: string; to: string } | null>(null);
  useEffect(() => {
    setRange(windowRange(windowDays));
  }, [windowDays]);

  const load = useCallback(async () => {
    if (!range) return;
    setLoading(true);
    setError(null);
    try {
      const query = buildAnalyticsQuery({
        serverId: serverId || null,
        from: range.from,
        to: range.to,
      });
      const res = await fetch(`/api/v1/analytics/dashboard${query}`, {
        credentials: 'include',
        cache: 'no-store',
      });
      if (!res.ok) throw new Error(`ошибка ${res.status}`);
      setData((await res.json()) as DashboardAnalytics);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [serverId, range]);

  useEffect(() => {
    void load();
  }, [load]);

  const csvHref = `/api/v1/analytics/dashboard${buildAnalyticsQuery({
    serverId: serverId || null,
    from: range?.from,
    to: range?.to,
    format: 'csv',
  })}`;

  const exportJson = useCallback(() => {
    if (!data) return;
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = 'analytics-dashboard.json';
    anchor.click();
    URL.revokeObjectURL(url);
  }, [data]);

  const scale = data ? peakScale(data.peak_by_hour) : 1;
  const segments = data ? outcomeSegments(data.match_outcomes) : [];
  const maxMap = data ? Math.max(1, ...data.popular_maps.map((m) => m.matches)) : 1;
  const maxLayer = data ? Math.max(1, ...data.popular_layers.map((l) => l.matches)) : 1;

  return (
    <section className="rounded border border-neutral-800 bg-neutral-950">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-neutral-900 px-4 py-2.5">
        <div className="flex items-baseline gap-2">
          <h2 className="text-xs uppercase tracking-[0.2em] text-neutral-300">Аналитика</h2>
          {loading ? <span className="text-[10px] text-neutral-500">загрузка…</span> : null}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <label className="sr-only" htmlFor={serverSelectId}>
            Сервер
          </label>
          <select
            id={serverSelectId}
            value={serverId}
            onChange={(e) => setServerId(e.target.value)}
            className="rounded border border-neutral-800 bg-neutral-900 px-2 py-1 text-xs text-neutral-200"
          >
            <option value="">Все серверы</option>
            {servers.map((s) => (
              <option key={s.id} value={s.id}>
                {s.display_name}
              </option>
            ))}
          </select>
          <label className="sr-only" htmlFor={windowSelectId}>
            Период
          </label>
          <select
            id={windowSelectId}
            value={windowDays}
            onChange={(e) => setWindowDays(Number(e.target.value))}
            className="rounded border border-neutral-800 bg-neutral-900 px-2 py-1 text-xs text-neutral-200"
          >
            {WINDOW_PRESETS.map((preset) => (
              <option key={preset.days} value={preset.days}>
                {preset.label}
              </option>
            ))}
          </select>
          <a
            href={csvHref}
            download
            className="rounded border border-neutral-800 bg-neutral-900 px-2.5 py-1 text-xs text-neutral-300 hover:border-sky-700 hover:text-sky-300"
          >
            CSV
          </a>
          <button
            type="button"
            onClick={exportJson}
            disabled={!data}
            className="rounded border border-neutral-800 bg-neutral-900 px-2.5 py-1 text-xs text-neutral-300 hover:border-sky-700 hover:text-sky-300 disabled:cursor-not-allowed disabled:opacity-40"
          >
            JSON
          </button>
        </div>
      </div>

      {error ? (
        <div className="px-4 py-6 text-center text-sm text-red-400">{error}</div>
      ) : !data ? (
        <div className="px-4 py-10 text-center text-sm text-neutral-500">Нет данных.</div>
      ) : (
        <div className="space-y-6 p-4">
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <StatTile label="Матчей" value={data.summary.total_matches.toLocaleString('ru-RU')} />
            <StatTile label="Часов онлайн" value={formatHours(data.summary.total_online_hours)} />
            <StatTile
              label="Уникальных игроков"
              value={data.summary.unique_players.toLocaleString('ru-RU')}
            />
            <StatTile
              label="Средняя длительность"
              value={formatDurationRu(data.summary.avg_match_duration_seconds)}
            />
          </div>

          <figure className="space-y-2">
            <figcaption className="text-[10px] uppercase tracking-[0.18em] text-neutral-500">
              Пик игроков по времени суток (UTC)
            </figcaption>
            <div
              className="flex h-32 items-end gap-[2px]"
              role="img"
              aria-label="Пик одновременно онлайн игроков по каждому часу суток"
            >
              {data.peak_by_hour.map((entry) => {
                const heightPct = Math.round((entry.peak_players / scale) * 100);
                return (
                  <div
                    key={entry.hour}
                    className="flex flex-1 items-end"
                    style={{ height: '100%' }}
                    title={`${formatHour(entry.hour)} — ${entry.peak_players}`}
                  >
                    <div
                      className="w-full rounded-t bg-sky-500/80 hover:bg-sky-400"
                      style={{ height: `${Math.max(entry.peak_players > 0 ? 4 : 1, heightPct)}%` }}
                    />
                  </div>
                );
              })}
            </div>
            <div className="flex justify-between text-[10px] font-mono text-neutral-600">
              {AXIS_HOURS.map((hour) => (
                <span key={hour}>{formatHour(hour)}</span>
              ))}
              <span>23:00</span>
            </div>
          </figure>

          <figure className="space-y-2">
            <figcaption className="text-[10px] uppercase tracking-[0.18em] text-neutral-500">
              Исходы матчей ({data.match_outcomes.total})
            </figcaption>
            {data.match_outcomes.total === 0 ? (
              <div className="text-xs text-neutral-600">Матчей за период нет.</div>
            ) : (
              <>
                <div className="flex h-3 w-full gap-[2px] overflow-hidden rounded">
                  {segments
                    .filter((seg) => seg.count > 0)
                    .map((seg) => (
                      <div
                        key={seg.key}
                        className={OUTCOME_FILL[seg.key]}
                        style={{ width: `${seg.percent}%` }}
                        title={`${seg.label}: ${seg.count} (${seg.percent}%)`}
                      />
                    ))}
                </div>
                <ul className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-neutral-400">
                  {segments.map((seg) => (
                    <li key={seg.key} className="inline-flex items-center gap-1.5">
                      <span className={`h-2 w-2 rounded-sm ${OUTCOME_FILL[seg.key]}`} />
                      <span>{seg.label}</span>
                      <span className="font-mono tabular-nums text-neutral-300">
                        {seg.count} · {seg.percent}%
                      </span>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </figure>

          <div className="grid gap-6 lg:grid-cols-2">
            <RankedBars
              title="Популярные карты"
              rows={data.popular_maps.map((m) => ({ label: m.map, value: m.matches }))}
              max={maxMap}
              fill="bg-sky-500/80"
            />
            <RankedBars
              title="Популярные слои"
              rows={data.popular_layers.map((l) => ({ label: l.layer, value: l.matches }))}
              max={maxLayer}
              fill="bg-violet-500/80"
            />
          </div>
        </div>
      )}
    </section>
  );
}

function StatTile({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col justify-between rounded border border-neutral-800 bg-neutral-900/40 p-3">
      <div className="text-[10px] uppercase tracking-[0.18em] text-neutral-500">{label}</div>
      <div className="mt-2 text-2xl font-semibold tabular-nums leading-none text-neutral-50">
        {value}
      </div>
    </div>
  );
}

function RankedBars({
  title,
  rows,
  max,
  fill,
}: {
  title: string;
  rows: Array<{ label: string; value: number }>;
  max: number;
  fill: string;
}) {
  return (
    <figure className="space-y-2">
      <figcaption className="text-[10px] uppercase tracking-[0.18em] text-neutral-500">
        {title}
      </figcaption>
      {rows.length === 0 ? (
        <div className="text-xs text-neutral-600">Нет данных.</div>
      ) : (
        <ul className="space-y-1.5">
          {rows.map((row) => (
            <li key={row.label} className="flex items-center gap-2">
              <span className="w-32 shrink-0 truncate text-xs text-neutral-300" title={row.label}>
                {row.label}
              </span>
              <span className="flex h-4 flex-1 items-center rounded bg-neutral-900">
                <span
                  className={`h-4 rounded ${fill}`}
                  style={{ width: `${Math.max(4, Math.round((row.value / max) * 100))}%` }}
                />
              </span>
              <span className="w-8 shrink-0 text-right font-mono text-xs tabular-nums text-neutral-300">
                {row.value}
              </span>
            </li>
          ))}
        </ul>
      )}
    </figure>
  );
}
