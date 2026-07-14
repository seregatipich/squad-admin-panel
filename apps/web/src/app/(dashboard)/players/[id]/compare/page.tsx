'use client';

import Link from 'next/link';
import { use } from 'react';

import { CompareOnlineView } from './CompareOnlineView';

export default function ComparePlayerOnlinePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ other?: string | string[] }>;
}) {
  const { id: playerId } = use(params);
  const { other } = use(searchParams);
  const initialOther = Array.isArray(other) ? other[0] : other;

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <Link href={`/players/${playerId}`} className="text-sm text-sky-400 hover:text-sky-300">
          ← К игроку
        </Link>
        <h1 className="text-2xl font-semibold">Сравнение онлайна</h1>
      </div>

      <CompareOnlineView playerId={playerId} initialOther={initialOther} />
    </div>
  );
}
