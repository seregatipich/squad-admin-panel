'use client';

import { Suspense } from 'react';
import { Card, PageContainer, Skeleton } from '@/components/ui';
import { MatchesBrowser } from './MatchesBrowser';

export default function MatchesPage() {
  return (
    <Suspense
      fallback={
        // Заголовок страницы приходит вместе с содержимым: второго `<h1>` на
        // время загрузки быть не должно.
        <PageContainer>
          <Skeleton variant="text" width="10rem" label="Загрузка списка матчей" />
          <Card padding="sm">
            <Skeleton variant="row" count={8} />
          </Card>
        </PageContainer>
      }
    >
      <MatchesBrowser />
    </Suspense>
  );
}
