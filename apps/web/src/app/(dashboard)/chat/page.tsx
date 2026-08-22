'use client';

import { Suspense } from 'react';
import { Card, PageContainer, Skeleton, SkeletonTable } from '@/components/ui';
import { ChatArchive } from './ChatArchive';

export default function ChatPage() {
  return (
    <Suspense
      fallback={
        // Заголовок страницы приходит вместе с содержимым: второго `<h1>` на
        // время загрузки быть не должно.
        <PageContainer>
          <Skeleton variant="text" width="8rem" label="Загружаем архив чата" />
          <Card padding="none">
            <SkeletonTable rows={8} cols={6} />
          </Card>
        </PageContainer>
      }
    >
      <ChatArchive />
    </Suspense>
  );
}
