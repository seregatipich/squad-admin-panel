import { Card, PageContainer, Skeleton } from '@/components/ui';

/**
 * Экран ожидания публичной части.
 *
 * Скелет здесь узкий, в отличие от панельного: публичная страница — это одна
 * колонка текста или один список, и форма ожидания повторяет именно её, чтобы
 * появление настоящего содержимого не сдвигало вёрстку.
 */
export default function PublicLoading() {
  return (
    <PageContainer width="reading">
      <div className="space-y-2">
        <Skeleton variant="block" width="16rem" className="h-6" label="Загружаем страницу" />
        <Skeleton variant="text" width="22rem" />
      </div>
      <Card>
        <Skeleton variant="row" count={5} />
      </Card>
    </PageContainer>
  );
}
