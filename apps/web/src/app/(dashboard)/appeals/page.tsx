'use client';

import { Suspense } from 'react';
import { AppealsBrowser } from './AppealsBrowser';

export default function AppealsPage() {
  return (
    <Suspense fallback={<div className="text-neutral-500">Загрузка…</div>}>
      <AppealsBrowser />
    </Suspense>
  );
}
