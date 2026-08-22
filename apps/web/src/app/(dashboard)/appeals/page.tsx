'use client';

import { Suspense } from 'react';
import { PageContainer, Skeleton } from '@/components/ui';
import { AppealsBrowser } from './AppealsBrowser';

export default function AppealsPage() {
  return (
    <Suspense
      fallback={
        <PageContainer width="wide">
          <Skeleton variant="block" label="Загрузка апелляций" />
          <Skeleton variant="card" count={3} />
        </PageContainer>
      }
    >
      <AppealsBrowser />
    </Suspense>
  );
}
