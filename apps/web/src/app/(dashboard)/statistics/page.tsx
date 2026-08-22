'use client';

import { Suspense } from 'react';
import { Card, PageContainer, Skeleton } from '@/components/ui';
import { StatisticsBrowser } from './StatisticsBrowser';

export default function StatisticsPage() {
  return (
    <Suspense
      fallback={
        // Заголовок страницы приходит вместе с содержимым: второго `<h1>` на
        // время загрузки быть не должно.
        <PageContainer>
          <Skeleton variant="text" width="10rem" label="Загрузка статистики" />
          <Card padding="sm">
            <Skeleton variant="card" count={2} />
          </Card>
        </PageContainer>
      }
    >
      <StatisticsBrowser />
    </Suspense>
  );
}
