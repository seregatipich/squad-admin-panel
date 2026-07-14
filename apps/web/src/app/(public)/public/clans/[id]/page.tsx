import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { formatOnlineHours, getPublicClan, type PublicClan } from '../clan-data';

export const dynamic = 'force-dynamic';

interface PublicClanPageProps {
  params: Promise<{ id: string }>;
}

export async function generateMetadata({ params }: PublicClanPageProps): Promise<Metadata> {
  try {
    const clan = await getPublicClan((await params).id);
    return {
      title: `${clan.name} — Squad Admin Panel`,
      description: clan.description ?? `Публичная страница клана ${clan.name}.`,
      openGraph: {
        title: clan.name,
        description: clan.description ?? `Публичная страница клана ${clan.name}.`,
      },
    };
  } catch {
    return { title: 'Клан — Squad Admin Panel' };
  }
}

/** Public, no-session clan page with a deliberately PII-free roster and history. */
export default async function PublicClanPage({ params }: PublicClanPageProps) {
  const { id } = await params;
  let clan: PublicClan;
  try {
    clan = await getPublicClan(id);
  } catch {
    notFound();
  }

  return (
    <div className="space-y-8">
      <header className="space-y-2 border-b border-neutral-900 pb-5">
        <div className="flex flex-wrap items-center gap-2 text-xs text-neutral-500">
          {clan.tags.map((tag) => (
            <span key={tag} className="rounded bg-neutral-900 px-2 py-1">
              {tag}
            </span>
          ))}
        </div>
        <h1 className="text-2xl font-semibold tracking-tight">{clan.name}</h1>
        {clan.description ? <p className="text-sm text-neutral-400">{clan.description}</p> : null}
      </header>

      <section className="grid gap-3 sm:grid-cols-4">
        <Stat title="Участников" value={String(clan.stats.roster_size)} />
        <Stat title="Матчей" value={String(clan.stats.matches_total)} />
        <Stat title="Онлайн за 30 дней" value={formatOnlineHours(clan.stats.online_seconds)} />
        <Stat title="K/D" value={clan.stats.kd.toFixed(2)} />
      </section>

      <section className="space-y-3">
        <h2 className="text-xs uppercase tracking-[0.2em] text-neutral-300">Ростер</h2>
        <div className="overflow-hidden rounded border border-neutral-800 bg-neutral-950">
          <table className="w-full text-sm">
            <tbody className="divide-y divide-neutral-900">
              {clan.roster.map((member, index) => (
                <tr key={`${member.nickname}-${index}`}>
                  <td className="px-4 py-2 text-neutral-200">{member.nickname}</td>
                  <td className="px-4 py-2 text-right text-neutral-500">{member.role}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {clan.roster.length === 0 ? (
            <p className="px-4 py-5 text-sm text-neutral-500">Ростер пуст.</p>
          ) : null}
        </div>
      </section>

      <section className="space-y-3">
        <h2 className="text-xs uppercase tracking-[0.2em] text-neutral-300">Активность</h2>
        <div className="flex h-28 items-end gap-1 rounded border border-neutral-800 bg-neutral-950 px-4 py-4">
          {clan.activity.map((point) => {
            const max = Math.max(...clan.activity.map((item) => item.online_seconds), 1);
            return (
              <div
                key={point.day}
                className="flex-1 rounded-t bg-sky-600"
                title={`${point.day} · ${formatOnlineHours(point.online_seconds)}`}
                style={{ height: `${Math.max(2, (point.online_seconds / max) * 100)}%` }}
              />
            );
          })}
        </div>
      </section>

      <section className="space-y-3">
        <h2 className="text-xs uppercase tracking-[0.2em] text-neutral-300">Последние матчи</h2>
        <div className="overflow-x-auto rounded border border-neutral-800 bg-neutral-950">
          <table className="w-full min-w-[38rem] text-sm">
            <thead className="border-b border-neutral-900 text-left text-xs text-neutral-500">
              <tr>
                <th className="px-4 py-2 font-normal">Дата</th>
                <th className="px-4 py-2 font-normal">Карта</th>
                <th className="px-4 py-2 font-normal">Слой</th>
                <th className="px-4 py-2 font-normal">Результат</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-neutral-900">
              {clan.matches.map((match) => (
                <tr key={match.id}>
                  <td className="px-4 py-2 text-neutral-400">
                    {new Date(match.started_at).toLocaleDateString('ru-RU')}
                  </td>
                  <td className="px-4 py-2 text-neutral-200">{match.map ?? '—'}</td>
                  <td className="px-4 py-2 font-mono text-xs text-neutral-400">
                    {match.layer ?? '—'}
                  </td>
                  <td className="px-4 py-2 text-neutral-400">{match.winner ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {clan.matches.length === 0 ? (
            <p className="px-4 py-5 text-sm text-neutral-500">Истории матчей пока нет.</p>
          ) : null}
        </div>
      </section>
    </div>
  );
}

function Stat({ title, value }: { title: string; value: string }) {
  return (
    <div className="rounded border border-neutral-800 bg-neutral-950 p-4">
      <div className="text-[10px] uppercase tracking-[0.2em] text-neutral-500">{title}</div>
      <div className="mt-2 text-2xl font-semibold tabular-nums text-neutral-50">{value}</div>
    </div>
  );
}
