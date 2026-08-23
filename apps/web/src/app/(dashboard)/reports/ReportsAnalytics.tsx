'use client';

import { useCallback, useEffect, useId, useMemo, useState } from 'react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import {
  Badge,
  Card,
  CardHeader,
  EmptyState,
  InlineBanner,
  Select,
  StatTile,
  Table,
  TableBody,
  TableHead,
  TableRow,
  Td,
  Th,
} from '@/components/ui';
import { CHART_AXIS, CHART_GRID, CHART_SERIES, CHART_TOOLTIP_STYLE } from '@/lib/chart-tokens';
import {
  buildReportsAnalyticsQuery,
  formatAccuracy,
  formatDurationRu,
  formatTrendDay,
  REPORTS_WINDOW_PRESETS,
  type ReportAnalytics,
  reportsWindowRange,
} from './analytics-data';
import {
  isRecidivist,
  REPORTER_SPAM_LABEL,
  REPORTER_TRUSTED_LABEL,
  recidivistBadgeLabel,
} from './helpers';

interface ServerOption {
  id: string;
  display_name: string;
}

/**
 * REPORT-5 (#115) reports analytics view: SLA/status breakdowns, trend,
 * top targets/reporters, CSV export. Gated by `can_handle_reports` on the
 * server; this component self-hides (renders nothing) on 401/403 so
 * non-handlers never see it, matching the other player-card/panel sections.
 */
export function ReportsAnalytics() {
  const [servers, setServers] = useState<ServerOption[]>([]);
  const [serverId, setServerId] = useState<string>('');
  const [windowDays, setWindowDays] = useState<number>(REPORTS_WINDOW_PRESETS[1].days);
  const [data, setData] = useState<ReportAnalytics | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hidden, setHidden] = useState(false);
  const serverSelectId = useId();
  const windowSelectId = useId();

  useEffect(() => {
    let cancelled = false;
    fetch('/api/v1/servers', { credentials: 'include', cache: 'no-store' })
      .then((res) => (res.ok ? res.json() : null))
      .then((body: { items?: ServerOption[] } | null) => {
        if (!cancelled) setServers(body?.items ?? []);
      })
      .catch(() => {
        if (!cancelled) setServers([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const range = useMemo(() => reportsWindowRange(windowDays), [windowDays]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const query = buildReportsAnalyticsQuery({
        serverId: serverId || null,
        from: range.from,
        to: range.to,
      });
      const res = await fetch(`/api/v1/analytics/reports${query}`, {
        credentials: 'include',
        cache: 'no-store',
      });
      if (res.status === 401 || res.status === 403) {
        setHidden(true);
        return;
      }
      if (!res.ok) throw new Error(`ошибка ${res.status}`);
      setData((await res.json()) as ReportAnalytics);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [serverId, range.from, range.to]);

  useEffect(() => {
    void load();
  }, [load]);

  if (hidden) return null;

  const csvHref = `/api/v1/analytics/reports${buildReportsAnalyticsQuery({
    serverId: serverId || null,
    from: range.from,
    to: range.to,
    format: 'csv',
  })}`;

  return (
    <Card as="section" padding="none">
      <CardHeader
        title="Аналитика жалоб"
        count={loading ? 'обновляем…' : undefined}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <label className="sr-only" htmlFor={serverSelectId}>
              Сервер
            </label>
            <Select
              id={serverSelectId}
              size="sm"
              value={serverId}
              onChange={(e) => setServerId(e.target.value)}
              className="w-auto"
            >
              <option value="">Все серверы</option>
              {servers.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.display_name}
                </option>
              ))}
            </Select>
            <label className="sr-only" htmlFor={windowSelectId}>
              Период
            </label>
            <Select
              id={windowSelectId}
              size="sm"
              value={windowDays}
              onChange={(e) => setWindowDays(Number(e.target.value))}
              className="w-auto"
            >
              {REPORTS_WINDOW_PRESETS.map((preset) => (
                <option key={preset.days} value={preset.days}>
                  {preset.label}
                </option>
              ))}
            </Select>
            {/* Выгрузка идёт прямой ссылкой на API, а не переходом внутри
                приложения, поэтому это обычный <a download>, а не ButtonLink. */}
            <a
              href={csvHref}
              download
              className="inline-flex h-7 items-center rounded-ctl border border-line bg-raised px-2.5 text-2xs font-medium text-ink no-underline transition-colors duration-150 hover:bg-line-2"
            >
              Скачать CSV
            </a>
          </div>
        }
      />

      {error ? (
        <div className="p-4">
          <InlineBanner tone="crit" title="Не удалось загрузить аналитику" description={error} />
        </div>
      ) : !data ? (
        <EmptyState title="Нет данных" description="Аналитика по жалобам ещё не собрана." />
      ) : data.summary.total === 0 ? (
        <EmptyState
          variant="filtered"
          title="За выбранный период жалоб нет"
          description="Расширьте период или снимите фильтр по серверу."
        />
      ) : (
        <div className="space-y-6 p-4">
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <StatTile label="Всего жалоб" value={data.summary.total.toLocaleString('ru-RU')} />
            <StatTile
              label="Ожидают / в работе"
              value={`${data.summary.by_status.pending} / ${data.summary.by_status.in_review}`}
            />
            <StatTile
              label="Решены / отклонены"
              value={`${data.summary.by_status.resolved} / ${data.summary.by_status.rejected}`}
            />
            <StatTile
              label="Среднее / медианное время"
              value={`${formatDurationRu(data.summary.avg_resolution_seconds)} / ${formatDurationRu(
                data.summary.median_resolution_seconds,
              )}`}
            />
          </div>

          <div>
            <h3 className="mb-2 text-[13px] font-semibold text-ink">Динамика жалоб</h3>
            <ResponsiveContainer width="100%" height={220}>
              <LineChart data={data.trend}>
                <CartesianGrid strokeDasharray="3 3" stroke={CHART_GRID} />
                <XAxis
                  dataKey="day"
                  tickFormatter={formatTrendDay}
                  stroke={CHART_AXIS}
                  minTickGap={24}
                />
                <YAxis allowDecimals={false} stroke={CHART_AXIS} />
                <Tooltip
                  contentStyle={CHART_TOOLTIP_STYLE}
                  labelFormatter={(day) => formatTrendDay(String(day))}
                />
                <Line
                  type="monotone"
                  dataKey="count"
                  stroke={CHART_SERIES.ram}
                  strokeWidth={2}
                  dot={false}
                />
              </LineChart>
            </ResponsiveContainer>
          </div>

          {data.by_server.length > 0 ? (
            <div>
              <h3 className="mb-2 text-[13px] font-semibold text-ink">
                Среднее время решения по серверам (SLA)
              </h3>
              <ResponsiveContainer width="100%" height={200}>
                <BarChart
                  data={data.by_handler.map((row) => ({
                    name: row.name ?? row.player_id.slice(0, 8),
                    seconds: row.avg_resolution_seconds ?? 0,
                  }))}
                >
                  <CartesianGrid strokeDasharray="3 3" stroke={CHART_GRID} />
                  <XAxis dataKey="name" stroke={CHART_AXIS} />
                  <YAxis stroke={CHART_AXIS} tickFormatter={(v: number) => formatDurationRu(v)} />
                  <Tooltip
                    contentStyle={CHART_TOOLTIP_STYLE}
                    formatter={(v) => formatDurationRu(typeof v === 'number' ? v : null)}
                  />
                  <Bar dataKey="seconds" fill={CHART_SERIES.cpu} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          ) : null}

          <div className="grid gap-6 lg:grid-cols-2">
            <div>
              <h3 className="mb-2 text-[13px] font-semibold text-ink">Топ целей</h3>
              {data.top_targets.length === 0 ? (
                <p className="text-xs text-ink-3">Нет данных.</p>
              ) : (
                <Table dense ariaLabel="Игроки, на которых чаще всего жалуются">
                  <TableHead>
                    <TableRow>
                      <Th>Игрок</Th>
                      <Th>30 дн</Th>
                      <Th>90 дн</Th>
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {data.top_targets.map((row) => (
                      <TableRow key={row.player_id}>
                        <Td>{row.name ?? row.player_id}</Td>
                        <Td className="text-ink-2">{row.count_30d}</Td>
                        <Td>
                          {isRecidivist(row.count_90d) ? (
                            <Badge tone="warn" size="sm">
                              {recidivistBadgeLabel(row.count_90d)}
                            </Badge>
                          ) : (
                            <span className="text-ink-2">{row.count_90d}</span>
                          )}
                        </Td>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </div>

            <div>
              <h3 className="mb-2 text-[13px] font-semibold text-ink">Топ репортёров</h3>
              {data.top_reporters.length === 0 ? (
                <p className="text-xs text-ink-3">Нет данных.</p>
              ) : (
                <Table dense ariaLabel="Игроки, чаще всего подающие жалобы">
                  <TableHead>
                    <TableRow>
                      <Th>Игрок</Th>
                      <Th>Точность</Th>
                      <Th>Статус</Th>
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {data.top_reporters.map((row) => (
                      <TableRow key={row.player_id}>
                        <Td>{row.name ?? row.player_id}</Td>
                        <Td className="text-ink-2">{formatAccuracy(row.accuracy)}</Td>
                        <Td>
                          <div className="flex gap-1">
                            {row.trusted ? (
                              <Badge tone="good" size="sm">
                                {REPORTER_TRUSTED_LABEL}
                              </Badge>
                            ) : null}
                            {row.spam_flagged ? (
                              <Badge tone="crit" size="sm">
                                {REPORTER_SPAM_LABEL}
                              </Badge>
                            ) : null}
                          </div>
                        </Td>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </div>
          </div>
        </div>
      )}
    </Card>
  );
}
