'use client';

import { Suspense } from 'react';
import { VotesBrowser } from './VotesBrowser';

export default function VotesPage() {
  return (
    <Suspense fallback={<div className="text-neutral-500">Загрузка…</div>}>
      <VotesBrowser />
    </Suspense>
  );
}
