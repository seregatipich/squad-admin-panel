'use client';
import Link from 'next/link';
import { useCallback, useEffect, useId, useState } from 'react';
import {
  Badge,
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

/*
 * Ссылка на выгрузку остаётся обычным `<a download>`, а не `ButtonLink`:
 * `next/link` перехватывает клик и уводит в клиентскую навигацию, из-за чего
 * файл не скачивается. Классы повторяют вторичную кнопку размера `sm` (§6).
 */
const DOWNLOAD_LINK_CLASS =
  'inline-flex h-7 items-center justify-center gap-1.5 whitespace-nowrap rounded-ctl border border-line bg-raised px-2.5 text-2xs font-medium text-ink no-underline transition-colors duration-150 hover:bg-line-2';

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
  const pending = !data && (loading || range === null);

  return (
    <Card as="section" padding="none">
      <CardHeader title="Голосования" />
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
                  {VOTE_WINDOW_PRESETS.map((preset) => (
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
            title="Аналитика голосований не загрузилась"
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
          <Skeleton variant="card" label="Загружаем аналитику голосований" />
          <Skeleton variant="block" count={2} />
        </CardBody>
      ) : !data ? (
        <EmptyState
          title="Данных за период нет"
          description="Выберите другой сервер или более длинный период."
        />
      ) : data.summary.total_votes === 0 ? (
        <EmptyState
          title="За выбранный период голосований нет."
          description="Расширьте период или выберите другой сервер."
        />
      ) : (
        <CardBody className="space-y-6">
          {/*
            Тон здесь получает только доля успешных: это единственный показатель,
            у которого есть «хорошо» и «плохо». Остальные три — просто счётчики,
            и красить их значило бы использовать цвет как украшение (§5).
          */}
          <CardGrid cols={4}>
            <StatTile
              label="Всего голосований"
              value={data.summary.total_votes.toLocaleString('ru-RU')}
            />
            <StatTile label="Прошло" value={data.summary.passed.toLocaleString('ru-RU')} />
            <StatTile
              label="Отклонено / отменено"
              value={(data.summary.failed + data.summary.cancelled).toLocaleString('ru-RU')}
            />
            <StatTile
              label="Доля успешных"
              value={formatPassRate(data.summary.pass_rate)}
              tone={passRateTone(data.summary.pass_rate)}
            />
          </CardGrid>

          <figure className="space-y-2">
            <figcaption className="text-[13px] font-semibold text-ink">
              Динамика голосований по дням
            </figcaption>
            {data.trend.length === 0 ? (
              <p className="text-xs text-ink-3">Нет данных.</p>
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
                          className="w-full rounded-t bg-accent/80 hover:bg-accent"
                          style={{ height: `${Math.max(entry.count > 0 ? 4 : 1, heightPct)}%` }}
                        />
                      </div>
                    );
                  })}
                </div>
                <div className="flex justify-between text-2xs tabular-nums text-ink-3">
                  <span>{formatTrendDay(data.trend[0].day)}</span>
                  <span>{formatTrendDay(data.trend[data.trend.length - 1].day)}</span>
                </div>
              </>
            )}
          </figure>

          <figure className="space-y-2">
            <figcaption className="text-[13px] font-semibold text-ink">
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
                      className="w-full rounded-t bg-accent/80 hover:bg-accent"
                      style={{ height: `${Math.max(entry.count > 0 ? 4 : 1, heightPct)}%` }}
                    />
                  </div>
                );
              })}
            </div>
            <div className="flex justify-between text-2xs tabular-nums text-ink-3">
              {AXIS_HOURS.map((hour) => (
                <span key={hour}>{formatVoteHour(hour)}</span>
              ))}
              <span>23:00</span>
            </div>
          </figure>

          <div className="grid gap-6 lg:grid-cols-2">
            <PassRateList
              title="Доля успешных по серверам"
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
              <figcaption className="text-[13px] font-semibold text-ink">
                Топ инициаторов
              </figcaption>
              {data.top_initiators.length === 0 ? (
                <p className="text-xs text-ink-3">Нет данных.</p>
              ) : (
                <ul className="divide-y divide-line overflow-hidden rounded-ctl border border-line">
                  {data.top_initiators.map((row) => (
                    <li
                      key={row.player_id}
                      className="flex items-center justify-between gap-2 px-2.5 py-2"
                    >
                      <Link
                        href={`/all-players/${row.player_id}`}
                        className="min-w-0 truncate text-xs text-accent no-underline"
                        title={row.nickname ?? row.player_id}
                      >
                        {row.nickname ?? row.player_id}
                      </Link>
                      <span className="flex shrink-0 items-center gap-1.5 text-xs tabular-nums text-ink-2">
                        {row.passed}/{row.initiated}
                        <Badge tone={passRateTone(row.success_ratio)} size="sm">
                          {formatPassRate(row.success_ratio)}
                        </Badge>
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </figure>

            <figure className="space-y-2">
              <figcaption className="text-[13px] font-semibold text-ink">
                Серийные скиперы
              </figcaption>
              {data.serial_skippers.length === 0 ? (
                <p className="text-xs text-ink-3">Порог не достигнут никем.</p>
              ) : (
                <ul className="divide-y divide-line overflow-hidden rounded-ctl border border-line">
                  {data.serial_skippers.map((row) => (
                    <li
                      key={row.player_id}
                      className="flex items-center justify-between gap-2 px-2.5 py-2"
                    >
                      <Link
                        href={`/all-players/${row.player_id}`}
                        className="min-w-0 truncate text-xs text-accent no-underline"
                        title={row.nickname ?? row.player_id}
                      >
                        {row.nickname ?? row.player_id}
                      </Link>
                      <Badge tone="crit" size="sm">
                        {row.skip_count} скипов
                      </Badge>
                    </li>
                  ))}
                </ul>
              )}
            </figure>
          </div>
        </CardBody>
      )}
    </Card>
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
      <figcaption className="text-[13px] font-semibold text-ink">{title}</figcaption>
      {rows.length === 0 ? (
        <p className="text-xs text-ink-3">Нет данных.</p>
      ) : (
        <ul className="space-y-1.5">
          {rows.map((row) => (
            <li key={row.key} className="flex items-center gap-2">
              <span className="w-32 shrink-0 truncate text-xs text-ink-2" title={row.label}>
                {row.label}
              </span>
              <span className="flex h-4 flex-1 items-center rounded-ctl bg-raised">
                <span
                  className="h-4 rounded-ctl bg-good/70"
                  style={{ width: `${Math.max(4, Math.round(row.rate))}%` }}
                />
              </span>
              <span className="w-24 shrink-0 text-right text-2xs tabular-nums text-ink-2">
                {row.passed}/{row.total} · {formatPassRate(row.rate)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </figure>
  );
}
