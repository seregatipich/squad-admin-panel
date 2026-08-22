'use client';

import { Suspense } from 'react';
import { Card, PageContainer, Skeleton } from '@/components/ui';
import { ExternalBansBrowser } from './ExternalBansBrowser';

export default function ExternalBansPage() {
  return (
    <Suspense
      fallback={
        // Заголовок страницы приходит вместе с содержимым: второго `<h1>` на
        // время загрузки быть не должно.
        <PageContainer width="wide">
          <Skeleton variant="text" width="14rem" label="Загрузка реестра внешних банов" />
          <Card padding="sm">
            <Skeleton variant="block" count={4} />
          </Card>
        </PageContainer>
      }
    >
      <ExternalBansBrowser />
    </Suspense>
  );
}
