'use client';

import { useEffect } from 'react';
import { Button, InlineBanner, PageContainer, PageHeader } from '@/components/ui';

/**
 * Граница ошибки раздела панели.
 *
 * Без неё исключение в серверном компоненте отдавало служебный экран Next.js —
 * по-английски, без пути назад и без единого признака того, что это та же
 * панель. Здесь оператор остаётся в интерфейсе, видит, что именно сломалось,
 * и может повторить попытку, не теряя сессию.
 *
 * `digest` — идентификатор, под которым Next.js записал ошибку на сервере;
 * он показан намеренно: без него оператор не может сослаться на конкретный
 * случай в отчёте, а текст самой ошибки в продакшене скрыт.
 */
export default function DashboardError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <PageContainer width="reading">
      <PageHeader title="Раздел не открылся" />
      <InlineBanner
        tone="crit"
        title="Панель не смогла загрузить эту страницу"
        description={
          <>
            Данные не пришли или ответ оказался неожиданным. Повторите попытку — если ошибка
            повторяется, приложите к отчёту идентификатор ниже.
            {error.digest && (
              <span className="mt-1 block font-mono text-2xs text-ink-3">{error.digest}</span>
            )}
          </>
        }
        action={
          <Button variant="primary" size="sm" onClick={reset}>
            Повторить
          </Button>
        }
      />
    </PageContainer>
  );
}
