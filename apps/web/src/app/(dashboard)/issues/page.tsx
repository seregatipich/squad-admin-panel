'use client';

import { Suspense } from 'react';
import { PageContainer, Skeleton, SkeletonTable } from '@/components/ui';
import { IssuesBrowser } from './IssuesBrowser';

export default function IssuesPage() {
  return (
    <Suspense
      fallback={
        <PageContainer>
          <Skeleton variant="block" label="Загрузка тикетов" />
          <SkeletonTable rows={8} cols={6} />
        </PageContainer>
      }
    >
      <IssuesBrowser />
    </Suspense>
  );
}
