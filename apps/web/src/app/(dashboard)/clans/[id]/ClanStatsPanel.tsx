'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';

interface ClanStatsChartPoint {
  day: string;
  online_seconds: number;
  boost_seconds: number;
}

interface ClanStatsServerTotal {
  server_id: string;
  server_name: string | null;
  server_slug: string | null;
  online_seconds: number;
}

interface ClanStatsPrimetimeRange {
  label: string;
  start_minutes: number;
  end_minutes: number;
  start_hour: number;
  end_hour: number;
}

interface ClanStatsCombatMember {
  player_id: string;
  canonical_name: string;
  kills: number;
  deaths: number;
  revives: number;
  kd: number;
}

interface ClanStatsResponse {
  clan_id: string;
  from: string;
  to: string;
  roster_size: number;
  chart: ClanStatsChartPoint[];
  totals: {
    online_seconds: number;
    boost_seconds: number;
    primary_server: ClanStatsServerTotal | null;
  };
  primetime: {
    total_seconds: number;
    histogram: number[];
    rolling_average: number[];
    range: ClanStatsPrimetimeRange | null;
  };
  combat: {
    kills: number;
    deaths: number;
    revives: number;
    kd: number;
    top: ClanStatsCombatMember[];
  };
}

type RangePreset = 7 | 30 | 90;

const RANGE_PRESETS: RangePreset[] = [7, 30, 90];
const RANGE_LABELS: Record<RangePreset, string> = {
  7: '7 дней',
  30: '30 дней',
  90: '90 дней',
};

const HOURS = Array.from({ length: 24 }, (_, hour) => hour);
const ONLINE_COLOR = '#30d158';
const BOOST_COLOR = '#ff9f0a';
const PEAK_COLOR = '#ff9f0a';
const PRIMETIME_BAR_COLOR = '#409cff';
const TOP_MEMBERS_DISPLAY_LIMIT = 5;
const DAY_MS = 86_400_000;

function todayUtcDay(): string {
  return new Date().toISOString().slice(0, 10);
}

function subtractDays(day: string, days: number): string {
  const ms = Date.parse(`${day}T00:00:00.000Z`) - days * DAY_MS;
  return new Date(ms).toISOString().slice(0, 10);
}

function fmtDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '0м';
  const total = Math.floor(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  if (hours > 0) return `${hours}ч ${minutes}м`;
  return `${minutes}м`;
}

function isPeakHour(hour: number, range: ClanStatsPrimetimeRange | null): boolean {
  if (!range) return false;
  const { start_hour: start, end_hour: end } = range;
  if (start <= end) return hour >= start && hour <= end;
  return hour >= start || hour <= end;
}

/** Fetches and renders aggregated clan stats: activity chart, totals, primetime, and combat leaders. */
export default function ClanStatsPanel({ clanId }: { clanId: string }) {
  const [range, setRange] = useState<RangePreset>(30);
  const [data, setData] = useState<ClanStatsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [hoverDay, setHoverDay] = useState<string | null>(null);

  const window = useMemo(() => {
    const to = todayUtcDay();
    return { from: subtractDays(to, range - 1), to };
  }, [range]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const query = new URLSearchParams({ from: window.from, to: window.to });
      const res = await fetch(`/api/v1/clans/${clanId}/stats?${query.toString()}`, {
        credentials: 'include',
        cache: 'no-store',
      });
      if (!res.ok) throw new Error(`Не удалось загрузить статистику (${res.status})`);
      setData((await res.json()) as ClanStatsResponse);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [clanId, window]);

  useEffect(() => {
    void load();
  }, [load]);

  const exportHref = `/api/v1/clans/${clanId}/stats/export?from=${window.from}&to=${window.to}&format=csv`;
  const maxDaySeconds = useMemo(
    () =>
      data
        ? Math.max(1, ...data.chart.map((point) => point.online_seconds + point.boost_seconds))
        : 1,
    [data],
  );
  const maxHourSeconds = useMemo(
    () => (data ? Math.max(1, ...data.primetime.histogram) : 1),
    [data],
  );
  const hoverPoint = hoverDay
    ? (data?.chart.find((point) => point.day === hoverDay) ?? null)
    : null;

  return (
    <section className="space-y-4 rounded border border-neutral-800 bg-neutral-950 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-lg font-medium">Статистика клана</h2>
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-1">
            {RANGE_PRESETS.map((preset) => (
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
                {RANGE_LABELS[preset]}
              </button>
            ))}
          </div>
          <Link
            href={exportHref}
            className="rounded border border-neutral-800 bg-neutral-900 px-2 py-0.5 text-xs text-neutral-300 hover:bg-neutral-800"
          >
            Экспорт CSV
          </Link>
        </div>
      </div>

      {error ? (
        <div className="rounded border border-red-900 bg-red-950 p-2 text-xs text-red-200">
          Ошибка: {error}
        </div>
      ) : loading || !data ? (
        <div className="text-sm text-neutral-500">Загрузка…</div>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <TotalCard
              label="Онлайн"
              value={fmtDuration(data.totals.online_seconds)}
              accent="text-emerald-300"
            />
            <TotalCard
              label="Буст"
              value={fmtDuration(data.totals.boost_seconds)}
              accent="text-amber-300"
            />
            <TotalCard
              label="Основной сервер"
              value={
                data.totals.primary_server?.server_name ??
                data.totals.primary_server?.server_slug ??
                '—'
              }
              accent="text-sky-300"
              small
            />
            <TotalCard
              label="Игроков в ростере"
              value={String(data.roster_size)}
              accent="text-neutral-200"
            />
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between text-xs">
              <div className="flex items-center gap-3 text-neutral-400">
                <Legend color={ONLINE_COLOR} label="Онлайн" />
                <Legend color={BOOST_COLOR} label="Буст" />
              </div>
              <span className="text-neutral-500">
                {hoverPoint ? (
                  <span className="tabular-nums">
                    {hoverPoint.day} ·{' '}
                    <span className="text-emerald-300">
                      {fmtDuration(hoverPoint.online_seconds)}
                    </span>
                    {hoverPoint.boost_seconds > 0 ? (
                      <>
                        {' '}
                        ·{' '}
                        <span className="text-amber-300">
                          буст {fmtDuration(hoverPoint.boost_seconds)}
                        </span>
                      </>
                    ) : null}
                  </span>
                ) : (
                  `${data.from} — ${data.to}`
                )}
              </span>
            </div>
            <ActivityChart
              chart={data.chart}
              maxSeconds={maxDaySeconds}
              hoverDay={hoverDay}
              onHover={setHoverDay}
            />
          </div>

          <div className="space-y-2 rounded border border-neutral-800 bg-neutral-900/40 p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="text-xs uppercase tracking-widest text-neutral-500">
                Праймтайм клана
              </div>
              {data.primetime.range ? (
                <span className="inline-flex items-center gap-2 rounded-full border border-amber-900 bg-amber-950/40 px-3 py-1">
                  <span
                    className="inline-block h-2 w-2 rounded-full"
                    style={{ backgroundColor: PEAK_COLOR }}
                  />
                  <span className="font-mono text-sm text-amber-200">
                    {data.primetime.range.label}
                  </span>
                </span>
              ) : (
                <span className="text-xs text-neutral-500">Недостаточно данных.</span>
              )}
            </div>
            <div className="flex items-end gap-px" style={{ height: 56 }}>
              {HOURS.map((hour) => {
                const seconds = data.primetime.histogram[hour] ?? 0;
                const heightPct = (seconds / maxHourSeconds) * 100;
                const peak = isPeakHour(hour, data.primetime.range);
                return (
                  <div
                    key={hour}
                    title={`${String(hour).padStart(2, '0')}:00 — ${fmtDuration(seconds)}`}
                    className="flex flex-1 items-end self-stretch"
                  >
                    <span
                      className="w-full rounded-sm"
                      style={{
                        height: `${Math.max(seconds > 0 ? 4 : 0, heightPct)}%`,
                        backgroundColor: peak ? PEAK_COLOR : PRIMETIME_BAR_COLOR,
                        opacity: 0.85,
                      }}
                    />
                  </div>
                );
              })}
            </div>
            <div className="flex justify-between text-[10px] tabular-nums text-neutral-500">
              {[0, 6, 12, 18, 23].map((hour) => (
                <span key={hour}>{String(hour).padStart(2, '0')}</span>
              ))}
            </div>
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <h3 className="text-xs uppercase tracking-widest text-neutral-500">Топ по фрагам</h3>
              <span className="text-xs text-neutral-500">
                K/D клана:{' '}
                <span className="tabular-nums text-neutral-300">{data.combat.kd.toFixed(2)}</span>
              </span>
            </div>
            {data.combat.top.length === 0 ? (
              <div className="rounded border border-dashed border-neutral-800 p-4 text-center text-sm text-neutral-500">
                Нет данных о бое за выбранный период.
              </div>
            ) : (
              <div className="overflow-x-auto rounded border border-neutral-800">
                <table className="w-full text-sm">
                  <thead className="bg-neutral-950 text-xs uppercase tracking-widest text-neutral-500">
                    <tr>
                      <th className="p-2 text-left">Участник</th>
                      <th className="p-2 text-right">Фраги</th>
                      <th className="p-2 text-right">Смерти</th>
                      <th className="p-2 text-right">Воскрешения</th>
                      <th className="p-2 text-right">K/D</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.combat.top.slice(0, TOP_MEMBERS_DISPLAY_LIMIT).map((member) => (
                      <tr key={member.player_id} className="border-t border-neutral-900">
                        <td className="p-2">
                          <Link
                            href={`/all-players/${member.player_id}`}
                            className="text-sky-400 hover:text-sky-300"
                          >
                            {member.canonical_name}
                          </Link>
                        </td>
                        <td className="p-2 text-right tabular-nums text-neutral-200">
                          {member.kills}
                        </td>
                        <td className="p-2 text-right tabular-nums text-neutral-400">
                          {member.deaths}
                        </td>
                        <td className="p-2 text-right tabular-nums text-neutral-400">
                          {member.revives}
                        </td>
                        <td className="p-2 text-right tabular-nums text-neutral-300">
                          {member.kd.toFixed(2)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </>
      )}
    </section>
  );
}

function TotalCard({
  label,
  value,
  accent,
  small,
}: {
  label: string;
  value: string;
  accent: string;
  small?: boolean;
}) {
  return (
    <div className="rounded border border-neutral-800 bg-neutral-900/40 p-3">
      <div className="text-xs uppercase tracking-widest text-neutral-500">{label}</div>
      <div className={`mt-1 truncate font-mono ${small ? 'text-base' : 'text-2xl'} ${accent}`}>
        {value}
      </div>
    </div>
  );
}

function Legend({ color, label }: { color: string; label: string }) {
  return (
    <span className="flex items-center gap-1">
      <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ backgroundColor: color }} />
      {label}
    </span>
  );
}

function ActivityChart({
  chart,
  maxSeconds,
  hoverDay,
  onHover,
}: {
  chart: ClanStatsChartPoint[];
  maxSeconds: number;
  hoverDay: string | null;
  onHover: (day: string | null) => void;
}) {
  if (chart.length === 0) {
    return (
      <div className="rounded border border-dashed border-neutral-800 p-6 text-center text-sm text-neutral-500">
        Нет данных о присутствии за период.
      </div>
    );
  }
  const labelStep = Math.max(1, Math.ceil(chart.length / 8));
  return (
    <div className="space-y-1">
      <div
        className="flex items-end gap-px"
        style={{ height: 120 }}
        onPointerLeave={() => onHover(null)}
      >
        {chart.map((point) => {
          const onlinePct = (point.online_seconds / maxSeconds) * 100;
          const boostPct = (point.boost_seconds / maxSeconds) * 100;
          const isHovered = hoverDay === point.day;
          return (
            <button
              type="button"
              key={point.day}
              onPointerEnter={() => onHover(point.day)}
              onFocus={() => onHover(point.day)}
              onBlur={() => onHover(null)}
              className="flex flex-1 flex-col items-stretch justify-end self-stretch bg-transparent"
              style={{ opacity: hoverDay === null || isHovered ? 1 : 0.5 }}
            >
              {point.boost_seconds > 0 ? (
                <span
                  className="w-full rounded-t-sm"
                  style={{ height: `${boostPct}%`, backgroundColor: BOOST_COLOR }}
                />
              ) : null}
              <span
                className="w-full"
                style={{
                  height: `${Math.max(point.online_seconds > 0 ? 2 : 0, onlinePct)}%`,
                  backgroundColor: ONLINE_COLOR,
                  borderRadius: point.boost_seconds > 0 ? 0 : '2px 2px 0 0',
                }}
              />
            </button>
          );
        })}
      </div>
      <div className="flex text-[10px] tabular-nums text-neutral-500">
        {chart.map((point, index) => (
          <span key={point.day} className="flex-1 text-center">
            {index % labelStep === 0 ? point.day.slice(5) : ''}
          </span>
        ))}
      </div>
    </div>
  );
}
