import { Card, PageContainer, Skeleton, SkeletonTable } from '@/components/ui';

/**
 * Экран ожидания для любого маршрута панели.
 *
 * До него переход между разделами не показывал ничего: страница просто
 * замирала на предыдущем содержимом, пока серверный компонент ждал ответа
 * API, и оператор не мог отличить медленный запрос от невыполненного клика.
 *
 * Форма повторяет каркас типичной страницы панели — заголовок, ряд карточек,
 * таблица, — поэтому появление настоящего содержимого не сдвигает вёрстку.
 */
export default function DashboardLoading() {
  return (
    <PageContainer>
      <div className="space-y-2">
        <Skeleton variant="block" width="14rem" className="h-6" label="Загружаем раздел" />
        <Skeleton variant="text" width="24rem" />
      </div>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {[0, 1, 2, 3].map((tile) => (
          <Card key={tile}>
            <Skeleton variant="text" width="6rem" />
            <Skeleton variant="block" width="8rem" className="mt-2 h-7" />
          </Card>
        ))}
      </div>
      <Card padding="none">
        <SkeletonTable rows={8} cols={5} />
      </Card>
    </PageContainer>
  );
}
