'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Button,
  Card,
  CardBody,
  CardGrid,
  CardHeader,
  EmptyState,
  InlineBanner,
  SegmentedControl,
  Skeleton,
  StatTile,
  Table,
  TableBody,
  TableHead,
  TableRow,
  Td,
  Th,
} from '@/components/ui';

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

/*
 * Ссылка на выгрузку остаётся обычным `<a>`, а не `ButtonLink`: `next/link`
 * перехватывает клик и уводит в клиентскую навигацию, из-за чего файл не
 * скачивается. Классы повторяют вторичную кнопку размера `sm` (§6).
 */
const DOWNLOAD_LINK_CLASS =
  'inline-flex h-7 items-center justify-center gap-1.5 whitespace-nowrap rounded-ctl border border-line bg-raised px-2.5 text-2xs font-medium text-ink no-underline transition-colors duration-150 hover:bg-line-2';

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
    <Card padding="none">
      <CardHeader
        title="Статистика клана"
        actions={
          <>
            <SegmentedControl
              size="sm"
              ariaLabel="Период статистики"
              value={String(range)}
              onChange={(next) => setRange(Number(next) as RangePreset)}
              items={RANGE_PRESETS.map((preset) => ({
                value: String(preset),
                label: RANGE_LABELS[preset],
              }))}
            />
            <a href={exportHref} className={DOWNLOAD_LINK_CLASS}>
              Экспорт CSV
            </a>
          </>
        }
      />

      <CardBody className="space-y-4">
        {error ? (
          <InlineBanner
            tone="crit"
            title="Не удалось загрузить статистику"
            description={error}
            action={
              <Button size="sm" onClick={() => void load()}>
                Повторить
              </Button>
            }
          />
        ) : loading || !data ? (
          <>
            <Skeleton variant="card" label="Загружаем статистику клана" />
            <Skeleton variant="block" count={2} />
          </>
        ) : (
          <>
            <CardGrid cols={4}>
              <StatTile
                size="sm"
                label="Онлайн"
                value={fmtDuration(data.totals.online_seconds)}
                tone="good"
              />
              <StatTile
                size="sm"
                label="Буст"
                value={fmtDuration(data.totals.boost_seconds)}
                tone="warn"
              />
              <StatTile
                size="sm"
                label="Основной сервер"
                value={
                  data.totals.primary_server?.server_name ??
                  data.totals.primary_server?.server_slug ??
                  '—'
                }
                tone="accent"
              />
              <StatTile size="sm" label="Игроков в ростере" value={String(data.roster_size)} />
            </CardGrid>

            <div className="space-y-2">
              <div className="flex items-center justify-between text-xs">
                <div className="flex items-center gap-3 text-ink-3">
                  <Legend color={ONLINE_COLOR} label="Онлайн" />
                  <Legend color={BOOST_COLOR} label="Буст" />
                </div>
                <span className="text-ink-3">
                  {hoverPoint ? (
                    <span className="tabular-nums">
                      {hoverPoint.day} ·{' '}
                      <span className="text-good">{fmtDuration(hoverPoint.online_seconds)}</span>
                      {hoverPoint.boost_seconds > 0 ? (
                        <>
                          {' '}
                          ·{' '}
                          <span className="text-warn">
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

            <div className="space-y-2 rounded-card border border-line bg-raised/40 p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h3 className="text-[13px] font-semibold text-ink">Праймтайм клана</h3>
                {data.primetime.range ? (
                  <span className="inline-flex items-center gap-2 rounded-full border border-warn/40 bg-warn/10 px-3 py-1">
                    <span
                      aria-hidden="true"
                      className="inline-block h-2 w-2 rounded-full"
                      style={{ backgroundColor: PEAK_COLOR }}
                    />
                    <span className="font-mono text-xs text-warn">
                      {data.primetime.range.label}
                    </span>
                  </span>
                ) : (
                  <span className="text-xs text-ink-3">Недостаточно данных.</span>
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
              <div className="flex justify-between text-2xs tabular-nums text-ink-3">
                {[0, 6, 12, 18, 23].map((hour) => (
                  <span key={hour}>{String(hour).padStart(2, '0')}</span>
                ))}
              </div>
            </div>

            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <h3 className="text-[13px] font-semibold text-ink">Топ по фрагам</h3>
                <span className="text-xs text-ink-3">
                  K/D клана:{' '}
                  <span className="tabular-nums text-ink-2">{data.combat.kd.toFixed(2)}</span>
                </span>
              </div>
              {data.combat.top.length === 0 ? (
                <EmptyState
                  title="Нет данных о бое"
                  description="За выбранный период у клана нет боевой статистики."
                />
              ) : (
                <Table ariaLabel="Топ участников клана по фрагам">
                  <TableHead sticky={false}>
                    <TableRow>
                      <Th>Участник</Th>
                      <Th align="right">Фраги</Th>
                      <Th align="right">Смерти</Th>
                      <Th align="right">Воскрешения</Th>
                      <Th align="right">K/D</Th>
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {data.combat.top.slice(0, TOP_MEMBERS_DISPLAY_LIMIT).map((member) => (
                      <TableRow key={member.player_id} interactive>
                        <Td>
                          <Link
                            href={`/all-players/${member.player_id}`}
                            className="text-accent no-underline hover:brightness-110"
                          >
                            {member.canonical_name}
                          </Link>
                        </Td>
                        <Td numeric>{member.kills}</Td>
                        <Td numeric className="text-ink-2">
                          {member.deaths}
                        </Td>
                        <Td numeric className="text-ink-2">
                          {member.revives}
                        </Td>
                        <Td numeric className="text-ink-2">
                          {member.kd.toFixed(2)}
                        </Td>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </div>
          </>
        )}
      </CardBody>
    </Card>
  );
}

function Legend({ color, label }: { color: string; label: string }) {
  return (
    <span className="flex items-center gap-1">
      <span
        aria-hidden="true"
        className="inline-block h-2.5 w-2.5 rounded-sm"
        style={{ backgroundColor: color }}
      />
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
      <EmptyState
        title="Нет данных о присутствии"
        description="За выбранный период участники клана не заходили на серверы."
      />
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
              aria-label={`${point.day}: онлайн ${fmtDuration(point.online_seconds)}`}
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
      <div className="flex text-2xs tabular-nums text-ink-3">
        {chart.map((point, index) => (
          <span key={point.day} className="flex-1 text-center">
            {index % labelStep === 0 ? point.day.slice(5) : ''}
          </span>
        ))}
      </div>
    </div>
  );
}
