'use client';

import { Suspense, use } from 'react';
import { Skeleton } from '@/components/ui';
import { EventsBrowser } from '../../../events/EventsBrowser';

export default function ServerEventsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  return (
    // Заглушка повторяет форму будущего содержимого — список событий, а не
    // строку «Загрузка…» (дизайн-система, §8). Объявление для скринридера
    // ставится один раз на всю область загрузки.
    <Suspense fallback={<Skeleton variant="row" count={8} label="Загружаем журнал событий" />}>
      <EventsBrowser lockedServerId={id} />
    </Suspense>
  );
}
