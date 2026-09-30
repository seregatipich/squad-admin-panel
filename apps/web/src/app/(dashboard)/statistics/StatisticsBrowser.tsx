'use client';

import dynamic from 'next/dynamic';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Button,
  Card,
  Checkbox,
  EmptyState,
  InlineBanner,
  PageContainer,
  PageHeader,
  Select,
  Skeleton,
  TextInput,
  Toolbar,
} from '@/components/ui';
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
const REVOKE_URL_DELAY_MS = 10_000;

const StackedSeriesChart = dynamic(
  () => import('./StatisticsCharts').then((mod) => mod.StackedSeriesChart),
  { ssr: false, loading: () => <ChartSkeleton /> },
);
const ModesDoughnut = dynamic(() => import('./StatisticsCharts').then((mod) => mod.ModesDoughnut), {
  ssr: false,
  loading: () => <ChartSkeleton />,
});

function ChartSkeleton() {
  return <div aria-hidden="true" className="h-[220px] animate-pulse rounded-ctl bg-raised" />;
}

/*
 * Ссылка на выгрузку остаётся обычным `<a download>`, а не `ButtonLink`:
 * `next/link` перехватывает клик и уводит в клиентскую навигацию, из-за чего
 * файл не скачивается. Классы повторяют вторичную кнопку размера `md` (§6).
 */
const DOWNLOAD_LINK_CLASS =
  'inline-flex h-8 items-center justify-center gap-1.5 whitespace-nowrap rounded-ctl border border-line bg-raised px-3 text-xs font-medium text-ink no-underline transition-colors duration-150 hover:bg-line-2';

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
  const commitTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Guards against out-of-order responses (#729): each `load()` call gets the
  // next id, and a response is applied only if no newer call has started
  // since — an overlapping older request (a fast preset click, a keystroke
  // inside the custom date inputs, or a Retry click) can otherwise resolve
  // after a newer one and overwrite fresher data, or clear `loading` early.
  const requestIdRef = useRef(0);
  const dropdownRef = useRef<HTMLDivElement | null>(null);

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

  // Клик вне списка и Escape закрывают его, иначе выбор серверов не применится.
  useEffect(() => {
    if (!dropdownOpen) return;
    const closeOnOutsidePointer = (event: PointerEvent) => {
      if (!dropdownRef.current?.contains(event.target as Node)) setDropdownOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setDropdownOpen(false);
    };
    document.addEventListener('pointerdown', closeOnOutsidePointer);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('pointerdown', closeOnOutsidePointer);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [dropdownOpen]);

  // The selection is committed when the dropdown closes, then debounced, so a
  // burst of checkbox clicks collapses into a single request.
  useEffect(() => {
    if (dropdownOpen) return;
    if (commitTimer.current) clearTimeout(commitTimer.current);
    commitTimer.current = setTimeout(
      () =>
        setCommitted((current) => {
          const unchanged =
            current.length === selected.length &&
            current.every((serverId, index) => serverId === selected[index]);
          return unchanged ? current : selected;
        }),
      SELECTION_DEBOUNCE_MS,
    );
    return () => {
      if (commitTimer.current) clearTimeout(commitTimer.current);
    };
  }, [dropdownOpen, selected]);

  const load = useCallback(async () => {
    if (!range) return;
    const requestId = ++requestIdRef.current;
    setLoading(true);
    setError(null);
    try {
      const query = buildStatisticsQuery({ from: range.from, to: range.to, servers: committed });
      const res = await fetch(`/api/v1/statistics${query}`, {
        credentials: 'include',
        cache: 'no-store',
      });
      if (!res.ok) throw new Error(`ошибка ${res.status}`);
      const body = (await res.json()) as StatisticsResponse;
      if (requestIdRef.current !== requestId) return;
      setData(body);
    } catch (e) {
      if (requestIdRef.current !== requestId) return;
      setError((e as Error).message);
    } finally {
      if (requestIdRef.current === requestId) setLoading(false);
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
    // Скачивание стартует асинхронно: немедленный revoke даёт пустой файл в Safari.
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), REVOKE_URL_DELAY_MS);
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
    <PageContainer>
      <PageHeader title="Статистика" />

      <Toolbar
        filters={
          <>
            <div ref={dropdownRef} className="relative">
              <Button onClick={() => setDropdownOpen((open) => !open)} aria-expanded={dropdownOpen}>
                {selectionLabel}
              </Button>
              {dropdownOpen ? (
                <div className="absolute z-10 mt-1 max-h-64 w-56 overflow-y-auto rounded-card border border-line bg-surface p-2">
                  {servers.length === 0 ? (
                    <p className="px-1 py-2 text-xs text-ink-3">Серверов нет.</p>
                  ) : (
                    servers.map((server) => (
                      <Checkbox
                        key={server.id}
                        checked={selected.includes(server.id)}
                        onChange={() => toggleServer(server.id)}
                        label={
                          <span className="flex min-w-0 items-center gap-2">
                            <span
                              aria-hidden="true"
                              className="h-2 w-2 shrink-0 rounded-sm"
                              style={{ background: serverColor(server.id, knownServerIds) }}
                            />
                            <span className="truncate">{server.display_name}</span>
                          </span>
                        }
                      />
                    ))
                  )}
                </div>
              ) : null}
            </div>

            <Select
              aria-label="Период"
              value={preset}
              onChange={(e) => setPreset(e.target.value as RangePreset)}
            >
              {RANGE_PRESETS.map((entry) => (
                <option key={entry.value} value={entry.value}>
                  {entry.label}
                </option>
              ))}
            </Select>

            {preset === 'custom' ? (
              <>
                <TextInput
                  type="date"
                  aria-label="Начало периода"
                  value={customFrom}
                  onChange={(e) => setCustomFrom(e.target.value)}
                />
                <TextInput
                  type="date"
                  aria-label="Конец периода"
                  value={customTo}
                  onChange={(e) => setCustomTo(e.target.value)}
                />
              </>
            ) : null}
          </>
        }
        actions={
          <>
            <a href={csvHref} download className={DOWNLOAD_LINK_CLASS}>
              CSV
            </a>
            <Button onClick={exportJson} disabled={!data}>
              JSON
            </Button>
          </>
        }
      />

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
      ) : !data ? (
        loading ? (
          <Card>
            <Skeleton variant="card" count={2} label="Загрузка статистики" />
          </Card>
        ) : (
          <Card>
            <EmptyState
              title="Нет данных."
              description="За выбранный период панель ничего не записала."
            />
          </Card>
        )
      ) : (
        <div className="space-y-6">
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
              additive
              series={data.matches.by_day}
              servers={chartServers}
              knownServerIds={knownServerIds}
              labelOf={dayLabel}
              drill="events"
            />
            <Card as="section" padding="sm">
              <figure>
                <figcaption className="text-[13px] font-semibold text-ink">Режимы</figcaption>
                {data.matches.modes.length === 0 ? (
                  <EmptyState title="Нет данных." />
                ) : (
                  <ModesDoughnut modes={data.matches.modes} />
                )}
              </figure>
            </Card>
            <RankedBars title="Топ боевых карт" rows={data.matches.maps} />
          </Block>

          <Block title="Сообщество">
            <ChartCard
              title="Новых игроков за день"
              additive
              series={data.community.new_players}
              servers={chartServers}
              knownServerIds={knownServerIds}
              labelOf={dayLabel}
              drill="events"
            />
            <ChartCard
              title="Сообщений чата за день"
              additive
              series={data.community.chat_messages}
              servers={chartServers}
              knownServerIds={knownServerIds}
              labelOf={dayLabel}
              drill="chat"
            />
            <ChartCard
              title="Тимкиллов за день"
              additive
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
              additive
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
    </PageContainer>
  );
}

function dayLabel(key: string): string {
  return key.slice(5);
}

function Block({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-3">
      <h2 className="text-[17px] font-semibold text-ink">{title}</h2>
      <div className="grid gap-4 xl:grid-cols-2">{children}</div>
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
    return <p className="text-xs text-ink-3">Ни один сервер не попал в выборку.</p>;
  }
  return (
    <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-ink-3">
      {servers.map((server) => (
        <li key={server.server_id} className="inline-flex items-center gap-1.5">
          <span
            aria-hidden="true"
            className="h-2 w-2 rounded-sm"
            style={{ background: serverColor(server.server_id, knownServerIds) }}
          />
          <span>{server.display_name}</span>
        </li>
      ))}
    </ul>
  );
}

/*
 * Мемоизирован: открытие списка серверов и клики по чекбоксам меняют только состояние
 * родителя, а пропсы карточек (серия, серверы, модульные `labelOf`) остаются теми же.
 */
const ChartCard = memo(function ChartCard({
  title,
  series,
  servers,
  knownServerIds,
  labelOf,
  drill,
  additive = false,
}: {
  title: string;
  series: StatisticsSeries;
  servers: Array<{ server_id: string; display_name: string }>;
  knownServerIds: string[];
  labelOf: (key: string) => string;
  drill?: DrillTarget;
  /** Точки суммируются осмысленно (счётчики); у средних и пиков «Всего» не показывается. */
  additive?: boolean;
}) {
  const [drillHref, setDrillHref] = useState<string | null>(null);

  // Ссылка относится к прошлой выборке: после смены данных такого столбца может не быть.
  // biome-ignore lint/correctness/useExhaustiveDependencies: сбрасываем при каждой новой серии
  useEffect(() => setDrillHref(null), [series]);

  return (
    <Card as="section" padding="sm">
      <figure>
        <figcaption className="flex flex-wrap items-baseline justify-between gap-2">
          <span className="text-[13px] font-semibold text-ink">{title}</span>
          <span className="text-xs tabular-nums text-ink-3">
            Среднее {formatMetric(series.kpi.avg)} · Максимум {formatMetric(series.kpi.max)}
            {additive ? ` · Всего ${formatMetric(stackedTotal(series))}` : null}
          </span>
        </figcaption>
        {series.totals.length === 0 || servers.length === 0 ? (
          <EmptyState title="Нет данных." />
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
            className="mt-2 inline-block text-xs text-accent no-underline hover:brightness-110"
          >
            Открыть выбранный срез →
          </a>
        ) : null}
      </figure>
    </Card>
  );
});

function RankedBars({
  title,
  rows,
}: {
  title: string;
  rows: Array<{ map: string; matches: number }>;
}) {
  const max = Math.max(1, ...rows.map((row) => row.matches));
  return (
    <Card as="section" padding="sm">
      <figure>
        <figcaption className="text-[13px] font-semibold text-ink">{title}</figcaption>
        {rows.length === 0 ? (
          <EmptyState title="Нет данных." />
        ) : (
          <ul className="mt-2 space-y-1.5">
            {rows.slice(0, 12).map((row) => (
              <li key={row.map} className="flex items-center gap-2">
                <span className="w-32 shrink-0 truncate text-xs text-ink-2" title={row.map}>
                  {row.map}
                </span>
                <span aria-hidden="true" className="flex h-4 flex-1 items-center rounded bg-raised">
                  <span
                    className="h-4 rounded bg-accent/80"
                    style={{ width: `${Math.max(4, Math.round((row.matches / max) * 100))}%` }}
                  />
                </span>
                <span className="w-8 shrink-0 text-right text-xs tabular-nums text-ink-2">
                  {row.matches}
                </span>
              </li>
            ))}
          </ul>
        )}
      </figure>
    </Card>
  );
}
