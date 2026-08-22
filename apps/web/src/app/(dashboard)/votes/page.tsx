'use client';

import { Suspense } from 'react';
import { Card, PageContainer, Skeleton } from '@/components/ui';
import { VotesBrowser } from './VotesBrowser';

export default function VotesPage() {
  return (
    <Suspense
      fallback={
        // Заголовок страницы приходит вместе с содержимым: второго `<h1>` на
        // время загрузки быть не должно.
        <PageContainer>
          <Skeleton variant="text" width="12rem" label="Загрузка голосований" />
          <Card padding="sm">
            <Skeleton variant="block" count={5} />
          </Card>
        </PageContainer>
      }
    >
      <VotesBrowser />
    </Suspense>
  );
}
