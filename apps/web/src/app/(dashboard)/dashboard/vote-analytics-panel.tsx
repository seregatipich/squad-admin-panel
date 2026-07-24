'use client';
import Link from 'next/link';
import { useCallback, useEffect, useId, useState } from 'react';
import {
  buildVotesQuery,
  formatPassRate,
  formatTrendDay,
  formatVoteHour,
  hourScale,
  passRateTone,
  trendScale,
  VOTE_WINDOW_PRESETS,
  type VoteAnalytics,
  voteWindowRange,
} from './vote-analytics-data';

interface ServerOption {
  id: string;
  display_name: string;
}

const AXIS_HOURS = [0, 6, 12, 18];

export function VoteAnalyticsPanel({ servers }: { servers: ServerOption[] }) {
  const [serverId, setServerId] = useState<string>('');
  const [windowDays, setWindowDays] = useState<number>(VOTE_WINDOW_PRESETS[1].days);
  const [data, setData] = useState<VoteAnalytics | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const serverSelectId = useId();
  const windowSelectId = useId();

  // See AnalyticsPanel: reading the clock during render desyncs SSR vs. the first client
  // render (a hydration mismatch on the CSV href). Defer voteWindowRange() to after mount.
  const [range, setRange] = useState<{ from: string; to: string } | null>(null);
  useEffect(() => {
    setRange(voteWindowRange(windowDays));
  }, [windowDays]);

  const load = useCallback(async () => {
    if (!range) return;
    setLoading(true);
    setError(null);
    try {
      const query = buildVotesQuery({ serverId: serverId || null, from: range.from, to: range.to });
      const res = await fetch(`/api/v1/analytics/votes${query}`, {
        credentials: 'include',
        cache: 'no-store',
      });
      if (!res.ok) throw new Error(`ошибка ${res.status}`);
      setData((await res.json()) as VoteAnalytics);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [serverId, range]);

  useEffect(() => {
    void load();
  }, [load]);

  const csvHref = `/api/v1/analytics/votes${buildVotesQuery({
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
    anchor.download = 'vote-analytics.json';
    anchor.click();
    URL.revokeObjectURL(url);
  }, [data]);

  const trendMax = data ? trendScale(data.trend) : 1;
  const hourMax = data ? hourScale(data.by_hour) : 1;

  return (
    <section className="rounded border border-neutral-800 bg-neutral-950">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-neutral-900 px-4 py-2.5">
        <div className="flex items-baseline gap-2">
          <h2 className="text-xs uppercase tracking-[0.2em] text-neutral-300">Голосования</h2>
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
            {VOTE_WINDOW_PRESETS.map((preset) => (
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
      ) : data.summary.total_votes === 0 ? (
        <div className="px-4 py-10 text-center text-sm text-neutral-500">
          За выбранный период голосований нет.
        </div>
      ) : (
        <div className="space-y-6 p-4">
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <StatTile
              label="Всего голосований"
              value={data.summary.total_votes.toLocaleString('ru-RU')}
            />
            <StatTile
              label="Прошло"
              value={data.summary.passed.toLocaleString('ru-RU')}
              tone="text-emerald-300"
            />
            <StatTile
              label="Отклонено / отменено"
              value={(data.summary.failed + data.summary.cancelled).toLocaleString('ru-RU')}
              tone="text-red-300"
            />
            <StatTile
              label="Доля успешных"
              value={formatPassRate(data.summary.pass_rate)}
              tone={passRateTone(data.summary.pass_rate)}
            />
          </div>

          <figure className="space-y-2">
            <figcaption className="text-[10px] uppercase tracking-[0.18em] text-neutral-500">
              Динамика голосований по дням
            </figcaption>
            {data.trend.length === 0 ? (
              <div className="text-xs text-neutral-600">Нет данных.</div>
            ) : (
              <>
                <div
                  className="flex h-28 items-end gap-[2px]"
                  role="img"
                  aria-label="Количество голосований по дням"
                >
                  {data.trend.map((entry) => {
                    const heightPct = Math.round((entry.count / trendMax) * 100);
                    return (
                      <div
                        key={entry.day}
                        className="flex flex-1 items-end"
                        style={{ height: '100%' }}
                        title={`${formatTrendDay(entry.day)} — ${entry.count}`}
                      >
                        <div
                          className="w-full rounded-t bg-sky-500/80 hover:bg-sky-400"
                          style={{ height: `${Math.max(entry.count > 0 ? 4 : 1, heightPct)}%` }}
                        />
                      </div>
                    );
                  })}
                </div>
                <div className="flex justify-between text-[10px] font-mono text-neutral-600">
                  <span>{formatTrendDay(data.trend[0].day)}</span>
                  <span>{formatTrendDay(data.trend[data.trend.length - 1].day)}</span>
                </div>
              </>
            )}
          </figure>

          <figure className="space-y-2">
            <figcaption className="text-[10px] uppercase tracking-[0.18em] text-neutral-500">
              Распределение по времени суток (UTC)
            </figcaption>
            <div
              className="flex h-28 items-end gap-[2px]"
              role="img"
              aria-label="Количество голосований по каждому часу суток"
            >
              {data.by_hour.map((entry) => {
                const heightPct = Math.round((entry.count / hourMax) * 100);
                return (
                  <div
                    key={entry.hour}
                    className="flex flex-1 items-end"
                    style={{ height: '100%' }}
                    title={`${formatVoteHour(entry.hour)} — ${entry.count}`}
                  >
                    <div
                      className="w-full rounded-t bg-violet-500/80 hover:bg-violet-400"
                      style={{ height: `${Math.max(entry.count > 0 ? 4 : 1, heightPct)}%` }}
                    />
                  </div>
                );
              })}
            </div>
            <div className="flex justify-between text-[10px] font-mono text-neutral-600">
              {AXIS_HOURS.map((hour) => (
                <span key={hour}>{formatVoteHour(hour)}</span>
              ))}
              <span>23:00</span>
            </div>
          </figure>

          <div className="grid gap-6 lg:grid-cols-2">
            <PassRateList
              title="Pass rate по серверам"
              rows={data.pass_rate_by_server.map((row) => ({
                key: row.server_id,
                label: row.server_name ?? row.server_id,
                passed: row.passed,
                total: row.total,
                rate: row.pass_rate,
              }))}
            />
            <PassRateList
              title="Чаще всего скипают карты"
              rows={data.pass_rate_by_map.map((row) => ({
                key: row.map,
                label: row.map,
                passed: row.passed,
                total: row.total,
                rate: row.pass_rate,
              }))}
            />
          </div>

          <div className="grid gap-6 lg:grid-cols-2">
            <figure className="space-y-2">
              <figcaption className="text-[10px] uppercase tracking-[0.18em] text-neutral-500">
                Топ инициаторов
              </figcaption>
              {data.top_initiators.length === 0 ? (
                <div className="text-xs text-neutral-600">Нет данных.</div>
              ) : (
                <ul className="space-y-1.5">
                  {data.top_initiators.map((row) => (
                    <li
                      key={row.player_id}
                      className="flex items-center justify-between gap-2 rounded border border-neutral-900 bg-neutral-900/40 px-2.5 py-1.5"
                    >
                      <Link
                        href={`/players/${row.player_id}`}
                        className="min-w-0 truncate text-xs text-sky-300 hover:text-sky-200"
                        title={row.nickname ?? row.player_id}
                      >
                        {row.nickname ?? row.player_id}
                      </Link>
                      <span className="shrink-0 font-mono text-[11px] tabular-nums text-neutral-300">
                        {row.passed}/{row.initiated} ·{' '}
                        <span className={passRateTone(row.success_ratio)}>
                          {formatPassRate(row.success_ratio)}
                        </span>
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </figure>

            <figure className="space-y-2">
              <figcaption className="text-[10px] uppercase tracking-[0.18em] text-neutral-500">
                Серийные скиперы
              </figcaption>
              {data.serial_skippers.length === 0 ? (
                <div className="text-xs text-neutral-600">Порог не достигнут никем.</div>
              ) : (
                <ul className="space-y-1.5">
                  {data.serial_skippers.map((row) => (
                    <li
                      key={row.player_id}
                      className="flex items-center justify-between gap-2 rounded border border-red-950 bg-red-950/30 px-2.5 py-1.5"
                    >
                      <Link
                        href={`/players/${row.player_id}`}
                        className="min-w-0 truncate text-xs text-red-200 hover:text-red-100"
                        title={row.nickname ?? row.player_id}
                      >
                        {row.nickname ?? row.player_id}
                      </Link>
                      <span className="shrink-0 rounded bg-red-950 px-1.5 py-0.5 font-mono text-[11px] tabular-nums text-red-300">
                        {row.skip_count} скипов
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </figure>
          </div>
        </div>
      )}
    </section>
  );
}

function StatTile({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className="flex flex-col justify-between rounded border border-neutral-800 bg-neutral-900/40 p-3">
      <div className="text-[10px] uppercase tracking-[0.18em] text-neutral-500">{label}</div>
      <div
        className={`mt-2 text-2xl font-semibold tabular-nums leading-none ${tone ?? 'text-neutral-50'}`}
      >
        {value}
      </div>
    </div>
  );
}

function PassRateList({
  title,
  rows,
}: {
  title: string;
  rows: Array<{ key: string; label: string; passed: number; total: number; rate: number }>;
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
            <li key={row.key} className="flex items-center gap-2">
              <span className="w-32 shrink-0 truncate text-xs text-neutral-300" title={row.label}>
                {row.label}
              </span>
              <span className="flex h-4 flex-1 items-center rounded bg-neutral-900">
                <span
                  className="h-4 rounded bg-emerald-500/70"
                  style={{ width: `${Math.max(4, Math.round(row.rate))}%` }}
                />
              </span>
              <span className="w-24 shrink-0 text-right font-mono text-[11px] tabular-nums text-neutral-300">
                {row.passed}/{row.total} · {formatPassRate(row.rate)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </figure>
  );
}
