'use client';

import dynamic from 'next/dynamic';
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { serverColor } from '@/lib/server-color';
import {
  buildStatisticsQuery,
  type DrillTarget,
  drillDownHref,
  formatMetric,
  hourLabel,
  presetRange,
  RANGE_PRESETS,
  type RangePreset,
  type StatisticsResponse,
  type StatisticsSeries,
  stackedTotal,
  weekdayLabel,
} from './helpers';

const SELECTION_DEBOUNCE_MS = 300;

const StackedSeriesChart = dynamic(
  () => import('./StatisticsCharts').then((mod) => mod.StackedSeriesChart),
  { ssr: false, loading: () => <ChartSkeleton /> },
);
const ModesDoughnut = dynamic(() => import('./StatisticsCharts').then((mod) => mod.ModesDoughnut), {
  ssr: false,
  loading: () => <ChartSkeleton />,
});

function ChartSkeleton() {
  return <div className="h-[220px] rounded bg-neutral-900/40" />;
}

interface ServerOption {
  id: string;
  display_name: string;
}

interface ServersResponse {
  items: Array<{ id: string; display_name: string }>;
}

export function StatisticsBrowser() {
  const [servers, setServers] = useState<ServerOption[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [committed, setCommitted] = useState<string[]>([]);
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [preset, setPreset] = useState<RangePreset>('30days');
  const [customFrom, setCustomFrom] = useState('');
  const [customTo, setCustomTo] = useState('');
  const [data, setData] = useState<StatisticsResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const presetSelectId = useId();
  const commitTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // `presetRange` reads the clock. Computing it during render makes the
  // server-rendered HTML and the first client render disagree (the CSV href
  // carries a `to=<now>` timestamp), which React reports as a hydration
  // mismatch. Defer the clock read to after mount.
  const [range, setRange] = useState<{ from: string; to: string } | null>(null);
  useEffect(() => {
    setRange(presetRange(preset, new Date(), customFrom, customTo));
  }, [preset, customFrom, customTo]);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/v1/servers', { credentials: 'include', cache: 'no-store' })
      .then(async (res) => (res.ok ? ((await res.json()) as ServersResponse) : { items: [] }))
      .then((body) => {
        if (cancelled) return;
        setServers(body.items.map((item) => ({ id: item.id, display_name: item.display_name })));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  // The selection is committed when the dropdown closes, then debounced, so a
  // burst of checkbox clicks collapses into a single request.
  useEffect(() => {
    if (dropdownOpen) return;
    if (commitTimer.current) clearTimeout(commitTimer.current);
    commitTimer.current = setTimeout(() => setCommitted(selected), SELECTION_DEBOUNCE_MS);
    return () => {
      if (commitTimer.current) clearTimeout(commitTimer.current);
    };
  }, [dropdownOpen, selected]);

  const load = useCallback(async () => {
    if (!range) return;
    setLoading(true);
    setError(null);
    try {
      const query = buildStatisticsQuery({ from: range.from, to: range.to, servers: committed });
      const res = await fetch(`/api/v1/statistics${query}`, {
        credentials: 'include',
        cache: 'no-store',
      });
      if (!res.ok) throw new Error(`ошибка ${res.status}`);
      setData((await res.json()) as StatisticsResponse);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [range, committed]);

  useEffect(() => {
    void load();
  }, [load]);

  const csvHref = `/api/v1/statistics${buildStatisticsQuery({
    from: range?.from,
    to: range?.to,
    servers: committed,
    format: 'csv',
  })}`;

  const exportJson = useCallback(() => {
    if (!data) return;
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = 'statistics.json';
    anchor.click();
    URL.revokeObjectURL(url);
  }, [data]);

  const knownServerIds = useMemo(() => servers.map((s) => s.id), [servers]);
  const chartServers = data?.servers ?? [];
  const selectionLabel = selected.length === 0 ? 'Все серверы' : `Серверов: ${selected.length}`;

  const toggleServer = (id: string) => {
    setSelected((current) =>
      current.includes(id) ? current.filter((entry) => entry !== id) : [...current, id],
    );
  };

  return (
    <section className="space-y-4">
      <header className="flex flex-wrap items-center justify-between gap-3 rounded border border-neutral-800 bg-neutral-950 px-4 py-2.5">
        <div className="flex items-baseline gap-2">
          <h1 className="text-xs uppercase tracking-[0.2em] text-neutral-300">Статистика</h1>
          {loading ? <span className="text-[10px] text-neutral-500">загрузка…</span> : null}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative">
            <button
              type="button"
              onClick={() => setDropdownOpen((open) => !open)}
              className="rounded border border-neutral-800 bg-neutral-900 px-2.5 py-1 text-xs text-neutral-200"
            >
              {selectionLabel}
            </button>
            {dropdownOpen ? (
              <div className="absolute z-10 mt-1 max-h-64 w-56 overflow-y-auto rounded border border-neutral-800 bg-neutral-950 p-2 shadow-xl">
                {servers.length === 0 ? (
                  <p className="px-1 py-2 text-[11px] text-neutral-500">Серверов нет.</p>
                ) : (
                  servers.map((server) => (
                    <label
                      key={server.id}
                      className="flex cursor-pointer items-center gap-2 px-1 py-1 text-xs text-neutral-300"
                    >
                      <input
                        type="checkbox"
                        checked={selected.includes(server.id)}
                        onChange={() => toggleServer(server.id)}
                      />
                      <span
                        className="h-2 w-2 shrink-0 rounded-sm"
                        style={{ background: serverColor(server.id, knownServerIds) }}
                      />
                      <span className="truncate">{server.display_name}</span>
                    </label>
                  ))
                )}
              </div>
            ) : null}
          </div>

          <label className="sr-only" htmlFor={presetSelectId}>
            Период
          </label>
          <select
            id={presetSelectId}
            value={preset}
            onChange={(e) => setPreset(e.target.value as RangePreset)}
            className="rounded border border-neutral-800 bg-neutral-900 px-2 py-1 text-xs text-neutral-200"
          >
            {RANGE_PRESETS.map((entry) => (
              <option key={entry.value} value={entry.value}>
                {entry.label}
              </option>
            ))}
          </select>

          {preset === 'custom' ? (
            <>
              <input
                type="date"
                aria-label="Начало периода"
                value={customFrom}
                onChange={(e) => setCustomFrom(e.target.value)}
                className="rounded border border-neutral-800 bg-neutral-900 px-2 py-1 text-xs text-neutral-200"
              />
              <input
                type="date"
                aria-label="Конец периода"
                value={customTo}
                onChange={(e) => setCustomTo(e.target.value)}
                className="rounded border border-neutral-800 bg-neutral-900 px-2 py-1 text-xs text-neutral-200"
              />
            </>
          ) : null}

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
      </header>

      {error ? (
        <p className="rounded border border-neutral-800 bg-neutral-950 px-4 py-10 text-center text-sm text-red-400">
          {error}
        </p>
      ) : !data ? (
        <p className="rounded border border-neutral-800 bg-neutral-950 px-4 py-10 text-center text-sm text-neutral-500">
          Нет данных.
        </p>
      ) : (
        <div className="space-y-4">
          <ServerLegend servers={chartServers} knownServerIds={knownServerIds} />

          <Block title="Население">
            <ChartCard
              title="Средний онлайн за день"
              series={data.population.avg_online}
              servers={chartServers}
              knownServerIds={knownServerIds}
              labelOf={dayLabel}
              drill="events"
            />
            <ChartCard
              title="Пик онлайна за день"
              series={data.population.peak_online}
              servers={chartServers}
              knownServerIds={knownServerIds}
              labelOf={dayLabel}
              drill="events"
            />
            <ChartCard
              title="Средняя очередь за день"
              series={data.population.avg_queue}
              servers={chartServers}
              knownServerIds={knownServerIds}
              labelOf={dayLabel}
            />
            <ChartCard
              title="Онлайн по часам суток (UTC)"
              series={data.population.by_hour}
              servers={chartServers}
              knownServerIds={knownServerIds}
              labelOf={hourLabel}
            />
            <ChartCard
              title="Онлайн по дням недели"
              series={data.population.by_weekday}
              servers={chartServers}
              knownServerIds={knownServerIds}
              labelOf={weekdayLabel}
            />
          </Block>

          <Block title="Матчи">
            <ChartCard
              title="Матчей за день"
              series={data.matches.by_day}
              servers={chartServers}
              knownServerIds={knownServerIds}
              labelOf={dayLabel}
              drill="events"
            />
            <figure className="rounded border border-neutral-800 bg-neutral-950 p-3">
              <figcaption className="text-[10px] uppercase tracking-[0.18em] text-neutral-500">
                Режимы
              </figcaption>
              {data.matches.modes.length === 0 ? (
                <p className="py-10 text-center text-xs text-neutral-600">Нет данных.</p>
              ) : (
                <ModesDoughnut modes={data.matches.modes} />
              )}
            </figure>
            <RankedBars title="Топ боевых карт" rows={data.matches.maps} />
          </Block>

          <Block title="Сообщество">
            <ChartCard
              title="Новых игроков за день"
              series={data.community.new_players}
              servers={chartServers}
              knownServerIds={knownServerIds}
              labelOf={dayLabel}
              drill="events"
            />
            <ChartCard
              title="Сообщений чата за день"
              series={data.community.chat_messages}
              servers={chartServers}
              knownServerIds={knownServerIds}
              labelOf={dayLabel}
              drill="chat"
            />
            <ChartCard
              title="Тимкиллов за день"
              series={data.community.teamkills}
              servers={chartServers}
              knownServerIds={knownServerIds}
              labelOf={dayLabel}
              drill="combat-log"
            />
          </Block>

          <Block title="Модерация">
            <ChartCard
              title="Наказаний за день"
              series={data.moderation.punishments}
              servers={chartServers}
              knownServerIds={knownServerIds}
              labelOf={dayLabel}
              drill="external-bans"
            />
            <ChartCard
              title="Средний онлайн админов"
              series={data.moderation.avg_admins}
              servers={chartServers}
              knownServerIds={knownServerIds}
              labelOf={dayLabel}
            />
            <ChartCard
              title="Пик онлайна админов"
              series={data.moderation.peak_admins}
              servers={chartServers}
              knownServerIds={knownServerIds}
              labelOf={dayLabel}
            />
          </Block>
        </div>
      )}
    </section>
  );
}

function dayLabel(key: string): string {
  return key.slice(5);
}

function Block({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-3">
      <h2 className="text-[11px] uppercase tracking-[0.2em] text-neutral-400">{title}</h2>
      <div className="grid gap-3 xl:grid-cols-2">{children}</div>
    </section>
  );
}

function ServerLegend({
  servers,
  knownServerIds,
}: {
  servers: Array<{ server_id: string; display_name: string }>;
  knownServerIds: string[];
}) {
  if (servers.length === 0) {
    return <p className="text-xs text-neutral-600">Ни один сервер не попал в выборку.</p>;
  }
  return (
    <ul className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-neutral-400">
      {servers.map((server) => (
        <li key={server.server_id} className="inline-flex items-center gap-1.5">
          <span
            className="h-2 w-2 rounded-sm"
            style={{ background: serverColor(server.server_id, knownServerIds) }}
          />
          <span>{server.display_name}</span>
        </li>
      ))}
    </ul>
  );
}

function ChartCard({
  title,
  series,
  servers,
  knownServerIds,
  labelOf,
  drill,
}: {
  title: string;
  series: StatisticsSeries;
  servers: Array<{ server_id: string; display_name: string }>;
  knownServerIds: string[];
  labelOf: (key: string) => string;
  drill?: DrillTarget;
}) {
  const [drillHref, setDrillHref] = useState<string | null>(null);
  const stacked = stackedTotal(series);

  return (
    <figure className="rounded border border-neutral-800 bg-neutral-950 p-3">
      <figcaption className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="text-[10px] uppercase tracking-[0.18em] text-neutral-500">{title}</span>
        <span className="font-mono text-[11px] tabular-nums text-neutral-400">
          Среднее {formatMetric(series.kpi.avg)} · Максимум {formatMetric(series.kpi.max)} · Всего{' '}
          {formatMetric(stacked)}
        </span>
      </figcaption>
      {series.totals.length === 0 || servers.length === 0 ? (
        <p className="py-10 text-center text-xs text-neutral-600">Нет данных.</p>
      ) : (
        <StackedSeriesChart
          series={series}
          servers={servers}
          knownServerIds={knownServerIds}
          labelOf={labelOf}
          onDrill={
            drill
              ? (serverId, key) =>
                  setDrillHref(drillDownHref(drill, serverId, /^\d{4}-/.test(key) ? key : null))
              : undefined
          }
        />
      )}
      {drillHref ? (
        <a
          href={drillHref}
          className="mt-2 inline-block text-[11px] text-sky-400 hover:text-sky-300"
        >
          Открыть выбранный срез →
        </a>
      ) : null}
    </figure>
  );
}

function RankedBars({
  title,
  rows,
}: {
  title: string;
  rows: Array<{ map: string; matches: number }>;
}) {
  const max = Math.max(1, ...rows.map((row) => row.matches));
  return (
    <figure className="rounded border border-neutral-800 bg-neutral-950 p-3">
      <figcaption className="text-[10px] uppercase tracking-[0.18em] text-neutral-500">
        {title}
      </figcaption>
      {rows.length === 0 ? (
        <p className="py-10 text-center text-xs text-neutral-600">Нет данных.</p>
      ) : (
        <ul className="mt-2 space-y-1.5">
          {rows.slice(0, 12).map((row) => (
            <li key={row.map} className="flex items-center gap-2">
              <span className="w-32 shrink-0 truncate text-xs text-neutral-300" title={row.map}>
                {row.map}
              </span>
              <span className="flex h-4 flex-1 items-center rounded bg-neutral-900">
                <span
                  className="h-4 rounded bg-sky-500/80"
                  style={{ width: `${Math.max(4, Math.round((row.matches / max) * 100))}%` }}
                />
              </span>
              <span className="w-8 shrink-0 text-right font-mono text-xs tabular-nums text-neutral-300">
                {row.matches}
              </span>
            </li>
          ))}
        </ul>
      )}
    </figure>
  );
}
