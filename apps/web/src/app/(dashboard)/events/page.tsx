'use client';

import { Suspense } from 'react';
import { Card, PageContainer, PageHeader, SkeletonTable } from '@/components/ui';
import { EventsBrowser } from './EventsBrowser';

/**
 * Верхний уровень журнала событий.
 *
 * `<h1>` страницы живёт здесь, а не в `EventsBrowser`: тот же компонент
 * встраивается в `/servers/[id]/events`, где заголовок первого уровня уже даёт
 * layout раздела с именем сервера. Заголовок стоит снаружи `Suspense`, поэтому
 * во время загрузки на экране ровно один `<h1>`, а не ноль и не два.
 */
export default function EventsPage() {
  return (
    <PageContainer>
      <PageHeader
        title="Журнал событий"
        subtitle="Конверты всех событий панели и серверов: фильтры по типу, серверу, игроку и периоду."
      />
      <Suspense
        fallback={
          <Card padding="none">
            <SkeletonTable rows={8} cols={5} label="Загружаем журнал событий" />
          </Card>
        }
      >
        <EventsBrowser />
      </Suspense>
    </PageContainer>
  );
}
