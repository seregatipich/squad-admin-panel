'use client';

import { Suspense } from 'react';
import { StatisticsBrowser } from './StatisticsBrowser';

export default function StatisticsPage() {
  return (
    <Suspense fallback={<div className="text-neutral-500">Загрузка…</div>}>
      <StatisticsBrowser />
    </Suspense>
  );
}
