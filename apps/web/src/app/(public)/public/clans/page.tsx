import type { Metadata } from 'next';
import Link from 'next/link';
import { getPublicClans } from './clan-data';

export const metadata: Metadata = {
  title: 'Публичные кланы — Squad Admin Panel',
  description: 'Каталог кланов, открытых для просмотра без входа в панель.',
};

export const dynamic = 'force-dynamic';

/** Public, no-session directory of clans whose visibility flag is enabled. */
export default async function PublicClansPage() {
  const { items } = await getPublicClans();

  return (
    <div className="space-y-6">
      <header className="space-y-1 border-b border-neutral-900 pb-4">
        <h1 className="text-2xl font-semibold tracking-tight">Публичные кланы</h1>
        <p className="text-sm text-neutral-400">Кланы, открытые для просмотра без входа.</p>
      </header>

      {items.length === 0 ? (
        <p className="rounded border border-neutral-800 bg-neutral-950 px-4 py-6 text-center text-sm text-neutral-500">
          Публичных кланов пока нет.
        </p>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          {items.map((clan) => (
            <Link
              key={clan.id}
              href={`/public/clans/${clan.id}`}
              className="rounded border border-neutral-800 bg-neutral-950 p-4 hover:border-sky-800"
            >
              <div className="flex items-start justify-between gap-3">
                <h2 className="font-semibold text-neutral-100">{clan.name}</h2>
                <span className="text-xs text-neutral-500">{clan.tags.join(' · ')}</span>
              </div>
              {clan.description ? (
                <p className="mt-2 line-clamp-3 text-sm text-neutral-400">{clan.description}</p>
              ) : null}
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
