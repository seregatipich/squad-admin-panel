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
import { Card, CardHeader, EmptyState, InlineBanner, Select } from '@/components/ui';
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
  REPORTER_SPAM_BADGE_CLASS,
  REPORTER_SPAM_LABEL,
  REPORTER_TRUSTED_BADGE_CLASS,
  REPORTER_TRUSTED_LABEL,
  recidivistBadgeLabel,
  TARGET_RECIDIVIST_BADGE_CLASS,
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
            <h3 className="mb-2 text-[11px] uppercase tracking-widest text-neutral-500">
              Динамика жалоб
            </h3>
            <ResponsiveContainer width="100%" height={220}>
              <LineChart data={data.trend}>
                <CartesianGrid strokeDasharray="3 3" stroke="#38383a" />
                <XAxis
                  dataKey="day"
                  tickFormatter={formatTrendDay}
                  stroke="#a1a1a8"
                  minTickGap={24}
                />
                <YAxis allowDecimals={false} stroke="#a1a1a8" />
                <Tooltip
                  contentStyle={{ background: '#2c2c2e', border: '1px solid #333' }}
                  labelFormatter={(day) => formatTrendDay(String(day))}
                />
                <Line
                  type="monotone"
                  dataKey="count"
                  stroke="#409cff"
                  strokeWidth={2}
                  dot={false}
                />
              </LineChart>
            </ResponsiveContainer>
          </div>

          {data.by_server.length > 0 ? (
            <div>
              <h3 className="mb-2 text-[11px] uppercase tracking-widest text-neutral-500">
                Среднее время решения по серверам (SLA)
              </h3>
              <ResponsiveContainer width="100%" height={200}>
                <BarChart
                  data={data.by_handler.map((row) => ({
                    name: row.name ?? row.player_id.slice(0, 8),
                    seconds: row.avg_resolution_seconds ?? 0,
                  }))}
                >
                  <CartesianGrid strokeDasharray="3 3" stroke="#38383a" />
                  <XAxis dataKey="name" stroke="#a1a1a8" />
                  <YAxis stroke="#a1a1a8" tickFormatter={(v: number) => formatDurationRu(v)} />
                  <Tooltip
                    contentStyle={{ background: '#2c2c2e', border: '1px solid #333' }}
                    formatter={(v) => formatDurationRu(typeof v === 'number' ? v : null)}
                  />
                  <Bar dataKey="seconds" fill="#30d158" />
                </BarChart>
              </ResponsiveContainer>
            </div>
          ) : null}

          <div className="grid gap-6 lg:grid-cols-2">
            <div>
              <h3 className="mb-2 text-[11px] uppercase tracking-widest text-neutral-500">
                Топ целей
              </h3>
              {data.top_targets.length === 0 ? (
                <p className="text-xs text-neutral-500">Нет данных.</p>
              ) : (
                <table className="w-full text-xs">
                  <thead>
                    <tr className="text-left text-neutral-500">
                      <th className="pb-1 font-normal">Игрок</th>
                      <th className="pb-1 font-normal">30 дн</th>
                      <th className="pb-1 font-normal">90 дн</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.top_targets.map((row) => (
                      <tr key={row.player_id} className="border-t border-neutral-900">
                        <td className="py-1 text-neutral-200">{row.name ?? row.player_id}</td>
                        <td className="py-1 text-neutral-400">{row.count_30d}</td>
                        <td className="py-1">
                          <span
                            className={
                              isRecidivist(row.count_90d)
                                ? `rounded px-1.5 py-0.5 ${TARGET_RECIDIVIST_BADGE_CLASS}`
                                : 'text-neutral-400'
                            }
                          >
                            {isRecidivist(row.count_90d)
                              ? recidivistBadgeLabel(row.count_90d)
                              : row.count_90d}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>

            <div>
              <h3 className="mb-2 text-[11px] uppercase tracking-widest text-neutral-500">
                Топ репортёров
              </h3>
              {data.top_reporters.length === 0 ? (
                <p className="text-xs text-neutral-500">Нет данных.</p>
              ) : (
                <table className="w-full text-xs">
                  <thead>
                    <tr className="text-left text-neutral-500">
                      <th className="pb-1 font-normal">Игрок</th>
                      <th className="pb-1 font-normal">Точность</th>
                      <th className="pb-1 font-normal">Статус</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.top_reporters.map((row) => (
                      <tr key={row.player_id} className="border-t border-neutral-900">
                        <td className="py-1 text-neutral-200">{row.name ?? row.player_id}</td>
                        <td className="py-1 text-neutral-400">{formatAccuracy(row.accuracy)}</td>
                        <td className="py-1">
                          <div className="flex gap-1">
                            {row.trusted ? (
                              <span
                                className={`rounded px-1.5 py-0.5 ${REPORTER_TRUSTED_BADGE_CLASS}`}
                              >
                                {REPORTER_TRUSTED_LABEL}
                              </span>
                            ) : null}
                            {row.spam_flagged ? (
                              <span
                                className={`rounded px-1.5 py-0.5 ${REPORTER_SPAM_BADGE_CLASS}`}
                              >
                                {REPORTER_SPAM_LABEL}
                              </span>
                            ) : null}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        </div>
      )}
    </Card>
  );
}

function StatTile({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded border border-neutral-800 bg-neutral-900 p-3">
      <div className="text-[11px] uppercase tracking-widest text-neutral-500">{label}</div>
      <div className="mt-1 text-lg font-semibold text-neutral-100">{value}</div>
    </div>
  );
}
