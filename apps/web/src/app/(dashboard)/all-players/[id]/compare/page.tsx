'use client';

import { use } from 'react';

import { InlineBanner, PageContainer, PageHeader } from '@/components/ui';
import { isUuid } from '@/lib/uuid';
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
  const requestedOther = Array.isArray(other) ? other[0] : other;
  // Both ids end up in API paths; a decoded route value that is not a UUID
  // could steer the request elsewhere (#472), so it is never used.
  const initialOther = requestedOther && isUuid(requestedOther) ? requestedOther : undefined;

  if (!isUuid(playerId)) {
    return (
      <PageContainer width="wide">
        <PageHeader
          title="Сравнение онлайна"
          backHref="/all-players"
          backLabel="К списку игроков"
        />
        <InlineBanner
          tone="crit"
          title="Некорректный идентификатор игрока"
          description="Ссылка повреждена: откройте игрока из списка."
        />
      </PageContainer>
    );
  }

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
