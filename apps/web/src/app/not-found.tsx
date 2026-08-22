import { ButtonLink, EmptyState, PageContainer } from '@/components/ui';

/**
 * Экран несуществующего адреса.
 *
 * Панель — приложение с закладками и ссылками в отчётах, поэтому устаревший
 * адрес здесь обычное дело. Раньше он приводил на служебную страницу Next.js
 * без выхода; теперь у оператора есть очевидный путь назад.
 */
export default function NotFound() {
  return (
    <PageContainer width="reading">
      <EmptyState
        title="Страница не найдена"
        description="Адрес больше не существует или ссылка устарела."
        action={<ButtonLink href="/dashboard">На дашборд</ButtonLink>}
      />
    </PageContainer>
  );
}
