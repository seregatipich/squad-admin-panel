'use client';

import { Suspense } from 'react';
import { ExternalBansBrowser } from './ExternalBansBrowser';

export default function ExternalBansPage() {
  return (
    <Suspense fallback={<div className="text-neutral-500">Загрузка…</div>}>
      <ExternalBansBrowser />
    </Suspense>
  );
}
