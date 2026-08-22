'use client';

import { Suspense } from 'react';
import { Card, PageContainer, PageHeader, Skeleton } from '@/components/ui';
import { CombatLog } from './CombatLog';

/**
 * `/combat-log` — общий боевой лог по всем серверам.
 *
 * `<h1>` страницы принадлежит этому файлу, а не {@link CombatLog}: тот же
 * компонент встроен в `/servers/[id]/combat-log`, где заголовок даёт layout
 * раздела сервера, и второй `<h1>` на странице лишил бы экранный диктор
 * единственной опоры (дизайн-система, §1).
 */
export default function CombatLogPage() {
  return (
    <PageContainer>
      <PageHeader title="Боевой лог" />
      <Suspense
        fallback={
          <Card padding="sm">
            <Skeleton variant="row" count={10} label="Загрузка боевого лога" />
          </Card>
        }
      >
        <CombatLog />
      </Suspense>
    </PageContainer>
  );
}
