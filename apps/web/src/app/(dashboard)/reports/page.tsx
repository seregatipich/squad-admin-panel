'use client';

import { Suspense } from 'react';
import { PageContainer, Skeleton } from '@/components/ui';
import { ReportsBrowser } from './ReportsBrowser';

export default function ReportsPage() {
  return (
    <Suspense
      fallback={
        <PageContainer width="wide">
          <Skeleton variant="block" label="Загрузка жалоб" />
          <Skeleton variant="card" count={3} />
        </PageContainer>
      }
    >
      <ReportsBrowser />
    </Suspense>
  );
}
