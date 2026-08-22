'use client';

import { Suspense } from 'react';
import { Card, PageContainer, Skeleton } from '@/components/ui';
import { LeaderboardsBrowser } from './LeaderboardsBrowser';

export default function LeaderboardsPage() {
  return (
    <Suspense
      fallback={
        // Заголовок страницы приходит вместе с содержимым: второго `<h1>` на
        // время загрузки быть не должно.
        <PageContainer>
          <Skeleton variant="text" width="10rem" label="Загрузка лидербордов" />
          <Card padding="sm">
            <Skeleton variant="row" count={10} />
          </Card>
        </PageContainer>
      }
    >
      <LeaderboardsBrowser />
    </Suspense>
  );
}
