'use client';

import { useEffect } from 'react';
import { Button, InlineBanner, PageContainer, PageHeader } from '@/components/ui';

/**
 * Граница ошибки личного кабинета.
 *
 * Кабинет — единственный экран игрока без доступа в панель: если он не
 * открылся, человеку некуда пойти дальше, поэтому экран обязан предложить
 * повтор, а не оставить пустую страницу.
 */
export default function MeError({ error, reset }: { error: Error; reset: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <PageContainer width="reading">
      <PageHeader title="Кабинет не открылся" />
      <InlineBanner
        tone="crit"
        title="Не удалось загрузить данные кабинета"
        description="Повторите попытку. Если это повторяется, напишите администрации сервера."
        action={
          <Button variant="primary" size="sm" onClick={reset}>
            Повторить
          </Button>
        }
      />
    </PageContainer>
  );
}
