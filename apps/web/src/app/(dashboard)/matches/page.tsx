'use client';

import { Suspense } from 'react';
import { MatchesBrowser } from './MatchesBrowser';

export default function MatchesPage() {
  return (
    <Suspense fallback={<div className="text-neutral-500">Загрузка…</div>}>
      <MatchesBrowser />
    </Suspense>
  );
}
