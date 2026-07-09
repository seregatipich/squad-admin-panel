import type { Metadata } from 'next';
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
    <div className="space-y-8">
      <header className="space-y-1 border-b border-neutral-900 pb-4">
        <h1 className="text-2xl font-semibold tracking-tight">Публичная статистика</h1>
        <p className="text-sm text-neutral-400">
          {new Date(stats.from).toLocaleDateString('ru-RU')} —{' '}
          {new Date(stats.to).toLocaleDateString('ru-RU')}
        </p>
      </header>

      <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard title="Матчей" value={stats.summary.total_matches.toString()} />
        <StatCard title="Игроков" value={stats.summary.unique_players.toString()} />
        <StatCard title="Наиграно часов" value={formatHours(stats.summary.total_online_hours)} />
        <StatCard
          title="Средняя длительность матча"
          value={formatDurationRu(stats.summary.avg_match_duration_seconds)}
        />
      </section>

      <section className="rounded border border-neutral-800 bg-neutral-950">
        <h2 className="border-b border-neutral-900 px-4 py-2.5 text-xs uppercase tracking-[0.2em] text-neutral-300">
          Пиковый онлайн по часам
        </h2>
        <div className="flex items-end gap-1 px-4 py-4" style={{ height: '120px' }}>
          {stats.peak_by_hour.map((entry) => (
            <div
              key={entry.hour}
              className="flex-1 rounded-t bg-sky-600"
              title={`${formatHour(entry.hour)} · ${entry.peak_players} игроков`}
              style={{ height: `${Math.max(2, (entry.peak_players / scale) * 100)}%` }}
            />
          ))}
        </div>
      </section>

      <section className="grid gap-5 lg:grid-cols-2">
        <PopularTable title="Популярные карты" rows={stats.popular_maps} labelKey="map" />
        <PopularTable title="Популярные слои" rows={stats.popular_layers} labelKey="layer" />
      </section>

      <section className="rounded border border-neutral-800 bg-neutral-950 px-4 py-3">
        <h2 className="mb-2 text-xs uppercase tracking-[0.2em] text-neutral-300">Итоги матчей</h2>
        <dl className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
          <Outcome label="Команда 1" value={stats.match_outcomes.team1} />
          <Outcome label="Команда 2" value={stats.match_outcomes.team2} />
          <Outcome label="Ничья" value={stats.match_outcomes.draw} />
          <Outcome label="Неизвестно" value={stats.match_outcomes.unknown} />
        </dl>
      </section>
    </div>
  );
}

function StatCard({ title, value }: { title: string; value: string }) {
  return (
    <div className="rounded border border-neutral-800 bg-neutral-950 p-4">
      <div className="text-[10px] uppercase tracking-[0.2em] text-neutral-500">{title}</div>
      <div className="mt-2 text-3xl font-semibold tabular-nums leading-none text-neutral-50">
        {value}
      </div>
    </div>
  );
}

function Outcome({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <dt className="text-[10px] uppercase tracking-[0.16em] text-neutral-500">{label}</dt>
      <dd className="text-lg font-semibold tabular-nums text-neutral-100">{value}</dd>
    </div>
  );
}

function PopularTable<K extends 'map' | 'layer'>({
  title,
  rows,
  labelKey,
}: {
  title: string;
  rows: Array<Record<K, string> & { matches: number }>;
  labelKey: K;
}) {
  return (
    <section className="rounded border border-neutral-800 bg-neutral-950">
      <h2 className="border-b border-neutral-900 px-4 py-2.5 text-xs uppercase tracking-[0.2em] text-neutral-300">
        {title}
      </h2>
      {rows.length === 0 ? (
        <div className="px-4 py-6 text-center text-sm text-neutral-500">нет данных</div>
      ) : (
        <table className="w-full text-sm">
          <tbody className="divide-y divide-neutral-900">
            {rows.map((row) => (
              <tr key={row[labelKey]}>
                <td className="px-4 py-2 text-neutral-200">{row[labelKey]}</td>
                <td className="px-4 py-2 text-right tabular-nums text-neutral-400">
                  {row.matches}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
