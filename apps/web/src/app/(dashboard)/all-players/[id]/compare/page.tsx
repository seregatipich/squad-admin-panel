'use client';

import { use } from 'react';

import { PageContainer, PageHeader } from '@/components/ui';
import { CompareOnlineView } from './CompareOnlineView';

export default function ComparePlayerOnlinePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ other?: string | string[] }>;
}) {
  const { id: playerId } = use(params);
  const { other } = use(searchParams);
  const initialOther = Array.isArray(other) ? other[0] : other;

  return (
    <PageContainer width="wide">
      <PageHeader
        title="Сравнение онлайна"
        subtitle="Часы, когда оба игрока были на серверах одновременно."
        backHref={`/all-players/${playerId}`}
        backLabel="К игроку"
      />

      <CompareOnlineView playerId={playerId} initialOther={initialOther} />
    </PageContainer>
  );
}
