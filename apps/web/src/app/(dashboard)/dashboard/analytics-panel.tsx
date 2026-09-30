'use client';
import {
  Button,
  Card,
  CardBody,
  CardGrid,
  CardHeader,
  InlineBanner,
  Skeleton,
  StatTile,
} from '@/components/ui';
import {
  type DashboardAnalytics,
  formatDurationRu,
  formatHour,
  formatHours,
  outcomeSegments,
  peakScale,
  WINDOW_PRESETS,
} from './analytics-data';
import {
  type AnalyticsServerOption,
  AnalyticsToolbar,
  AXIS_HOURS,
  useAnalyticsWindow,
} from './analytics-window';

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

export function AnalyticsPanel({ servers }: { servers: AnalyticsServerOption[] }) {
  const state = useAnalyticsWindow<DashboardAnalytics>(
    '/api/v1/analytics/dashboard',
    WINDOW_PRESETS[0].days,
  );
  const { data, error, load } = state;

  const scale = data ? peakScale(data.peak_by_hour) : 1;
  const segments = data ? outcomeSegments(data.match_outcomes) : [];
  const maxMap = data ? Math.max(1, ...data.popular_maps.map((m) => m.matches)) : 1;
  const maxLayer = data ? Math.max(1, ...data.popular_layers.map((l) => l.matches)) : 1;
  // Первый ответ ещё не пришёл: диапазон считается после монтирования, поэтому
  // до него запрос даже не уходил (§8 — «что грузится»).
  // A successful response always yields `data` (even an all-zero summary);
  // the only paths where `!data` holds are "still loading" and "load
  // failed", and the error branch above is checked first — so the
  // EmptyState this used to gate on was unreachable except as a same-frame
  // flicker before `loading` flipped true.
  const pending = !data;

  return (
    <Card as="section" padding="none">
      <CardHeader title="Аналитика" />
      <CardBody padding="sm" className="border-b border-line">
        <AnalyticsToolbar
          servers={servers}
          window={state}
          jsonFileName="analytics-dashboard.json"
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
