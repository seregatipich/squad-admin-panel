import type { Metadata } from 'next';
import {
  Card,
  CardBody,
  CardGrid,
  CardHeader,
  EmptyState,
  PageContainer,
  PageHeader,
  StatTile,
  Table,
  TableBody,
  TableHead,
  TableRow,
  Td,
  Th,
} from '@/components/ui';
import { formatDurationRu, formatHour, formatHours, getPublicStats, peakScale } from './stats-data';

export const metadata: Metadata = {
  title: 'Статистика — Squad Admin Panel',
  description: 'Публичная агрегированная статистика серверов, без входа в систему.',
};

export const dynamic = 'force-dynamic';

/**
 * Public, no-session stats portal (`/stats`). Server-renders the curated,
 * PII-free network aggregates served by `GET /api/v1/public/stats` — no
 * per-server or per-player data, no sidebar, no auth.
 */
export default async function PublicStatsPage() {
  const stats = await getPublicStats();
  const scale = peakScale(stats.peak_by_hour);

  return (
    <PageContainer width="wide">
      <PageHeader
        title="Публичная статистика"
        subtitle={`${new Date(stats.from).toLocaleDateString('ru-RU')} — ${new Date(
          stats.to,
        ).toLocaleDateString('ru-RU')}`}
      />

      <CardGrid cols={4}>
        <StatTile label="Матчей" value={stats.summary.total_matches} />
        <StatTile label="Игроков" value={stats.summary.unique_players} />
        <StatTile label="Наиграно часов" value={formatHours(stats.summary.total_online_hours)} />
        <StatTile
          label="Средняя длительность матча"
          value={formatDurationRu(stats.summary.avg_match_duration_seconds)}
        />
      </CardGrid>

      <Card padding="none">
        <CardHeader title="Пиковый онлайн по часам" />
        <CardBody>
          {/* Столбики — иллюстрация распределения: число за каждым часом живёт в
              подсказке, поэтому программе чтения с экрана полоса не нужна. */}
          <div aria-hidden="true" className="flex h-28 items-end gap-1">
            {stats.peak_by_hour.map((entry) => (
              <div
                key={entry.hour}
                className="flex-1 rounded-t bg-accent"
                title={`${formatHour(entry.hour)} · ${entry.peak_players} игроков`}
                style={{ height: `${Math.max(2, (entry.peak_players / scale) * 100)}%` }}
              />
            ))}
          </div>
        </CardBody>
      </Card>

      <CardGrid cols={2}>
        <PopularTable
          title="Популярные карты"
          columnLabel="Карта"
          rows={stats.popular_maps}
          labelKey="map"
        />
        <PopularTable
          title="Популярные слои"
          columnLabel="Слой"
          rows={stats.popular_layers}
          labelKey="layer"
        />
      </CardGrid>

      <Card padding="none">
        <CardHeader title="Итоги матчей" />
        <CardBody>
          <dl className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            <Outcome label="Команда 1" value={stats.match_outcomes.team1} />
            <Outcome label="Команда 2" value={stats.match_outcomes.team2} />
            <Outcome label="Ничья" value={stats.match_outcomes.draw} />
            <Outcome label="Неизвестно" value={stats.match_outcomes.unknown} />
          </dl>
        </CardBody>
      </Card>
    </PageContainer>
  );
}

/** Служебный ярлык над значением — единственное место, где допустим капслок (§1). */
function Outcome({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex flex-col gap-1">
      <dt className="text-2xs uppercase tracking-[0.06em] text-ink-3">{label}</dt>
      <dd className="text-[17px] font-semibold tabular-nums text-ink">{value}</dd>
    </div>
  );
}

function PopularTable<K extends 'map' | 'layer'>({
  title,
  columnLabel,
  rows,
  labelKey,
}: {
  title: string;
  /** Название первой колонки: у каждой таблицы оно своё — карта или слой. */
  columnLabel: string;
  rows: Array<Record<K, string> & { matches: number }>;
  labelKey: K;
}) {
  return (
    <Card padding="none">
      <CardHeader title={title} />
      {rows.length === 0 ? (
        <EmptyState title="Данных пока нет." description="За выбранный период матчи не сыграны." />
      ) : (
        <Table ariaLabel={title}>
          <TableHead sticky={false}>
            <TableRow>
              <Th>{columnLabel}</Th>
              <Th align="right">Матчей</Th>
            </TableRow>
          </TableHead>
          <TableBody>
            {rows.map((row) => (
              <TableRow key={row[labelKey]}>
                <Td>{row[labelKey]}</Td>
                <Td numeric>{row.matches}</Td>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </Card>
  );
}
