import { Card, CardGrid, PageContainer, Skeleton } from '@/components/ui';

/** Экран ожидания личного кабинета: заголовок, две карточки состояния и список. */
export default function MeLoading() {
  return (
    <PageContainer width="reading">
      <div className="space-y-2">
        <Skeleton variant="block" width="12rem" className="h-6" label="Загружаем кабинет" />
        <Skeleton variant="text" width="18rem" />
      </div>
      <CardGrid cols={2}>
        {[0, 1].map((tile) => (
          <Card key={tile}>
            <Skeleton variant="text" width="7rem" />
            <Skeleton variant="block" width="9rem" className="mt-2 h-7" />
          </Card>
        ))}
      </CardGrid>
      <Card>
        <Skeleton variant="row" count={4} />
      </Card>
    </PageContainer>
  );
}
