'use client';
import { useCallback, useEffect, useId, useState } from 'react';
import {
  Button,
  Card,
  CardBody,
  CardGrid,
  CardHeader,
  EmptyState,
  InlineBanner,
  Select,
  Skeleton,
  StatTile,
  Toolbar,
} from '@/components/ui';
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

/*
 * Категориальные цвета: они существуют только чтобы соседние доли диаграммы
 * различались между собой, и ничего не сообщают о состоянии системы (§5).
 * Смысл каждой доли несёт подпись в легенде, а не её цвет.
 */
const OUTCOME_FILL: Record<string, string> = {
  team1: 'bg-sky-500',
  team2: 'bg-emerald-500',
  draw: 'bg-amber-500',
  unknown: 'bg-neutral-600',
};

/* Две соседние диаграммы рядом: разный оттенок нужен только чтобы взгляд не
   путал их столбики между собой — оценки в цвете нет (§5). */
const RANKED_FILL = {
  maps: 'bg-accent/80',
  layers: 'bg-purple-500/80',
} as const;

const AXIS_HOURS = [0, 6, 12, 18];

/*
 * Ссылка на выгрузку остаётся обычным `<a download>`, а не `ButtonLink`:
 * `next/link` перехватывает клик и уводит в клиентскую навигацию, из-за чего
 * файл не скачивается. Классы повторяют вторичную кнопку размера `sm` (§6).
 */
const DOWNLOAD_LINK_CLASS =
  'inline-flex h-7 items-center justify-center gap-1.5 whitespace-nowrap rounded-ctl border border-line bg-raised px-2.5 text-2xs font-medium text-ink no-underline transition-colors duration-150 hover:bg-line-2';

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
  // Первый ответ ещё не пришёл: диапазон считается после монтирования, поэтому
  // до него запрос даже не уходил (§8 — «что грузится»).
  const pending = !data && (loading || range === null);

  return (
    <Card as="section" padding="none">
      <CardHeader title="Аналитика" />
      <CardBody padding="sm" className="border-b border-line">
        <Toolbar
          filters={
            <>
              <label className="sr-only" htmlFor={serverSelectId}>
                Сервер
              </label>
              <div className="w-44">
                <Select
                  id={serverSelectId}
                  size="sm"
                  value={serverId}
                  onChange={(e) => setServerId(e.target.value)}
                >
                  <option value="">Все серверы</option>
                  {servers.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.display_name}
                    </option>
                  ))}
                </Select>
              </div>
              <label className="sr-only" htmlFor={windowSelectId}>
                Период
              </label>
              <div className="w-28">
                <Select
                  id={windowSelectId}
                  size="sm"
                  value={windowDays}
                  onChange={(e) => setWindowDays(Number(e.target.value))}
                >
                  {WINDOW_PRESETS.map((preset) => (
                    <option key={preset.days} value={preset.days}>
                      {preset.label}
                    </option>
                  ))}
                </Select>
              </div>
            </>
          }
          summary={loading ? 'Обновляем…' : undefined}
          actions={
            <>
              <a href={csvHref} download className={DOWNLOAD_LINK_CLASS}>
                CSV
              </a>
              <Button size="sm" onClick={exportJson} disabled={!data}>
                JSON
              </Button>
            </>
          }
        />
      </CardBody>

      {error ? (
        <CardBody>
          <InlineBanner
            tone="crit"
            title="Аналитика не загрузилась"
            description={error}
            action={
              <Button size="sm" onClick={() => void load()}>
                Повторить
              </Button>
            }
          />
        </CardBody>
      ) : pending ? (
        <CardBody className="space-y-4">
          <Skeleton variant="card" label="Загружаем аналитику" />
          <Skeleton variant="block" count={2} />
        </CardBody>
      ) : !data ? (
        <EmptyState
          title="Данных за период нет"
          description="Выберите другой сервер или более длинный период."
        />
      ) : (
        <CardBody className="space-y-6">
          <CardGrid cols={4}>
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
          </CardGrid>

          <figure className="space-y-2">
            <figcaption className="text-[13px] font-semibold text-ink">
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
                      className="w-full rounded-t bg-accent/80 hover:bg-accent"
                      style={{ height: `${Math.max(entry.peak_players > 0 ? 4 : 1, heightPct)}%` }}
                    />
                  </div>
                );
              })}
            </div>
            <div className="flex justify-between text-2xs tabular-nums text-ink-3">
              {AXIS_HOURS.map((hour) => (
                <span key={hour}>{formatHour(hour)}</span>
              ))}
              <span>23:00</span>
            </div>
          </figure>

          <figure className="space-y-2">
            <figcaption className="text-[13px] font-semibold text-ink">
              Исходы матчей ({data.match_outcomes.total})
            </figcaption>
            {data.match_outcomes.total === 0 ? (
              <p className="text-xs text-ink-3">Матчей за период нет.</p>
            ) : (
              <>
                <div className="flex h-3 w-full gap-[2px] overflow-hidden rounded-ctl">
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
                <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-ink-3">
                  {segments.map((seg) => (
                    <li key={seg.key} className="inline-flex items-center gap-1.5">
                      <span
                        aria-hidden="true"
                        className={`h-1.5 w-1.5 rounded-full ${OUTCOME_FILL[seg.key]}`}
                      />
                      <span>{seg.label}</span>
                      <span className="tabular-nums text-ink-2">
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
              fill={RANKED_FILL.maps}
            />
            <RankedBars
              title="Популярные слои"
              rows={data.popular_layers.map((l) => ({ label: l.layer, value: l.matches }))}
              max={maxLayer}
              fill={RANKED_FILL.layers}
            />
          </div>
        </CardBody>
      )}
    </Card>
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
      <figcaption className="text-[13px] font-semibold text-ink">{title}</figcaption>
      {rows.length === 0 ? (
        <p className="text-xs text-ink-3">Нет данных.</p>
      ) : (
        <ul className="space-y-1.5">
          {rows.map((row) => (
            <li key={row.label} className="flex items-center gap-2">
              <span className="w-32 shrink-0 truncate text-xs text-ink-2" title={row.label}>
                {row.label}
              </span>
              <span className="flex h-4 flex-1 items-center rounded-ctl bg-raised">
                <span
                  className={`h-4 rounded-ctl ${fill}`}
                  style={{ width: `${Math.max(4, Math.round((row.value / max) * 100))}%` }}
                />
              </span>
              <span className="w-8 shrink-0 text-right text-xs tabular-nums text-ink-2">
                {row.value}
              </span>
            </li>
          ))}
        </ul>
      )}
    </figure>
  );
}
