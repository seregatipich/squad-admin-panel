import type { Metadata } from 'next';
import Link from 'next/link';
import { Card, CardGrid, EmptyState, PageContainer, PageHeader } from '@/components/ui';
import { getPublicClans } from './clan-data';

export const metadata: Metadata = {
  title: 'Публичные кланы — Squad Admin Panel',
  description: 'Каталог кланов, открытых для просмотра без входа в панель.',
};

export const dynamic = 'force-dynamic';

/**
 * Карточка-ссылка: весь прямоугольник ведёт на страницу клана, поэтому это
 * настоящий `<a>` целиком, а не карточка с ссылкой внутри. Готового примитива
 * для такой роли нет — отсюда единственная строка классов на этой странице,
 * собранная из тех же токенов, что и `Card`.
 */
const CLAN_CARD_CLASS =
  'block rounded-card border border-line bg-surface p-4 no-underline transition-colors duration-150 hover:border-line-2 hover:bg-raised/40';

/** Public, no-session directory of clans whose visibility flag is enabled. */
export default async function PublicClansPage() {
  const { items } = await getPublicClans();

  return (
    <PageContainer width="wide">
      <PageHeader
        title="Публичные кланы"
        subtitle="Кланы, открытые для просмотра без входа."
        meta={items.length > 0 ? `Всего: ${items.length}` : undefined}
      />

      {items.length === 0 ? (
        <Card padding="none">
          <EmptyState
            title="Публичных кланов пока нет."
            description="Клан появится здесь, когда его администрация откроет страницу для всех."
          />
        </Card>
      ) : (
        <CardGrid cols={2}>
          {items.map((clan) => (
            <Link key={clan.id} href={`/public/clans/${clan.id}`} className={CLAN_CARD_CLASS}>
              <div className="flex items-start justify-between gap-3">
                {/* Заголовок оставлен настоящим `h2`: по списку кланов удобнее
                    всего идти именно навигацией по заголовкам. */}
                <h2 className="text-[13px] font-semibold text-ink">{clan.name}</h2>
                <span className="shrink-0 text-2xs text-ink-3">{clan.tags.join(' · ')}</span>
              </div>
              {clan.description ? (
                <p className="mt-2 line-clamp-3 text-xs text-ink-3">{clan.description}</p>
              ) : null}
            </Link>
          ))}
        </CardGrid>
      )}
    </PageContainer>
  );
}
