'use client';

import { Suspense, use } from 'react';
import { EventsBrowser } from '../../../events/EventsBrowser';

export default function ServerEventsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  return (
    <Suspense fallback={<div className="text-neutral-500">Загрузка…</div>}>
      <EventsBrowser lockedServerId={id} />
    </Suspense>
  );
}
