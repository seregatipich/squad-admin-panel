'use client';

import { Suspense } from 'react';
import { ReportsBrowser } from './ReportsBrowser';

export default function ReportsPage() {
  return (
    <Suspense fallback={<div className="text-neutral-500">Загрузка…</div>}>
      <ReportsBrowser />
    </Suspense>
  );
}
