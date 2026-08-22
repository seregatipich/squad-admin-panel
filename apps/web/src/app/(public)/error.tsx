'use client';

import { useEffect } from 'react';
import { Button, InlineBanner, PageContainer, PageHeader } from '@/components/ui';

/**
 * Граница ошибки публичной части.
 *
 * Отличается от панельной адресатом: сюда приходит игрок, а не оператор, и
 * ему нечего делать с идентификатором ошибки и нечем помочь себе, кроме как
 * повторить попытку. Поэтому здесь нет `digest` и нет предложения приложить
 * его к отчёту — только то, что человек действительно может сделать.
 */
export default function PublicError({ error, reset }: { error: Error; reset: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <PageContainer width="reading">
      <PageHeader title="Страница не открылась" />
      <InlineBanner
        tone="crit"
        title="Не удалось загрузить страницу"
        description="Похоже, сервис временно недоступен. Повторите попытку через минуту."
        action={
          <Button variant="primary" size="sm" onClick={reset}>
            Повторить
          </Button>
        }
      />
    </PageContainer>
  );
}
