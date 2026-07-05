'use client';

import { Suspense } from 'react';
import { LeaderboardsBrowser } from './LeaderboardsBrowser';

export default function LeaderboardsPage() {
  return (
    <Suspense fallback={<div className="text-neutral-500">Загрузка…</div>}>
      <LeaderboardsBrowser />
    </Suspense>
  );
}
