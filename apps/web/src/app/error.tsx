'use client';

import { useEffect } from 'react';
import { Button, InlineBanner, PageContainer, PageHeader } from '@/components/ui';

/**
 * Корневая граница ошибки.
 *
 * Ловит то, что не поймали границы разделов: сбой в корневой странице и в
 * макетах `(dashboard)`/`(me)` — граница сегмента не перехватывает ошибку
 * собственного `layout.tsx`. Главный случай — `getSession()` (`lib/dal.ts`)
 * пробрасывает отказ API вместо того, чтобы выдать его за отсутствие сессии,
 * поэтому оператор видит сбой, а не экран входа (#827).
 *
 * `digest` — идентификатор, под которым Next.js записал ошибку на сервере.
 */
export default function RootError({
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
      <PageHeader title="Панель недоступна" />
      <InlineBanner
        tone="crit"
        title="Сервер панели не ответил"
        description={
          <>
            Сессия не сброшена: повторите попытку через несколько секунд. Если ошибка повторяется,
            приложите к отчёту идентификатор ниже.
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
