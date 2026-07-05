'use client';

import { Suspense } from 'react';
import { EventsBrowser } from './EventsBrowser';

export default function EventsPage() {
  return (
    <Suspense fallback={<div className="text-neutral-500">Загрузка…</div>}>
      <EventsBrowser />
    </Suspense>
  );
}
