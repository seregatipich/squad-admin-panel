import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import {
  Badge,
  Card,
  CardBody,
  CardGrid,
  CardHeader,
  EmptyState,
  PageContainer,
  PageHeader,
  StatTile,
  Table,
  TableBody,
  TableHead,
  TableRow,
  Td,
  Th,
} from '@/components/ui';
import { formatOnlineHours, getPublicClan, type PublicClan } from '../clan-data';

export const dynamic = 'force-dynamic';

interface PublicClanPageProps {
  params: Promise<{ id: string }>;
}

export async function generateMetadata({ params }: PublicClanPageProps): Promise<Metadata> {
  try {
    const clan = await getPublicClan((await params).id);
    return {
      title: `${clan.name} — Squad Admin Panel`,
      description: clan.description ?? `Публичная страница клана ${clan.name}.`,
      openGraph: {
        title: clan.name,
        description: clan.description ?? `Публичная страница клана ${clan.name}.`,
      },
    };
  } catch {
    return { title: 'Клан — Squad Admin Panel' };
  }
}

/** Public, no-session clan page with a deliberately PII-free roster and history. */
export default async function PublicClanPage({ params }: PublicClanPageProps) {
  const { id } = await params;
  let clan: PublicClan;
  try {
    clan = await getPublicClan(id);
  } catch {
    notFound();
  }

  const activityPeak = Math.max(...clan.activity.map((item) => item.online_seconds), 1);

  return (
    <PageContainer width="wide">
      <PageHeader
        title={clan.name}
        subtitle={clan.description ?? undefined}
        backHref="/public/clans"
        backLabel="К списку кланов"
        meta={clan.tags.map((tag) => (
          <Badge key={tag} size="sm">
            {tag}
          </Badge>
        ))}
      />

      <CardGrid cols={4}>
        <StatTile label="Участников" value={clan.stats.roster_size} />
        <StatTile label="Матчей" value={clan.stats.matches_total} />
        <StatTile label="Онлайн за 30 дней" value={formatOnlineHours(clan.stats.online_seconds)} />
        <StatTile label="K/D" value={clan.stats.kd.toFixed(2)} />
      </CardGrid>

      <Card padding="none">
        <CardHeader title="Ростер" count={clan.roster.length} />
        {clan.roster.length === 0 ? (
          <EmptyState
            title="Ростер пуст."
            description="Клан ещё не показал состав на публичной странице."
          />
        ) : (
          <Table ariaLabel={`Состав клана ${clan.name}`}>
            <TableHead sticky={false}>
              <TableRow>
                <Th>Игрок</Th>
                <Th>Роль</Th>
              </TableRow>
            </TableHead>
            <TableBody>
              {clan.roster.map((member, index) => (
                <TableRow key={`${member.nickname}-${index}`}>
                  <Td>{member.nickname}</Td>
                  <Td className="text-ink-3">{member.role}</Td>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Card>

      <Card padding="none">
        <CardHeader title="Активность" description="Онлайн клана по дням за последний месяц." />
        <CardBody>
          {/* Столбики — иллюстрация распределения: число за каждый день живёт в
              подсказке, поэтому программе чтения с экрана полоса не нужна. */}
          <div aria-hidden="true" className="flex h-28 items-end gap-1">
            {clan.activity.map((point) => (
              <div
                key={point.day}
                className="flex-1 rounded-t bg-accent"
                title={`${point.day} · ${formatOnlineHours(point.online_seconds)}`}
                style={{ height: `${Math.max(2, (point.online_seconds / activityPeak) * 100)}%` }}
              />
            ))}
          </div>
        </CardBody>
      </Card>

      <Card padding="none">
        <CardHeader title="Последние матчи" count={clan.matches.length} />
        {clan.matches.length === 0 ? (
          <EmptyState
            title="Истории матчей пока нет."
            description="Первый сыгранный матч появится здесь автоматически."
          />
        ) : (
          <Table ariaLabel={`Последние матчи клана ${clan.name}`}>
            <TableHead sticky={false}>
              <TableRow>
                <Th>Дата</Th>
                <Th>Карта</Th>
                <Th>Слой</Th>
                <Th>Результат</Th>
              </TableRow>
            </TableHead>
            <TableBody>
              {clan.matches.map((match) => (
                <TableRow key={match.id}>
                  <Td>{new Date(match.started_at).toLocaleDateString('ru-RU')}</Td>
                  <Td>{match.map ?? '—'}</Td>
                  <Td className="font-mono text-xs">{match.layer ?? '—'}</Td>
                  <Td>{match.winner ?? '—'}</Td>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Card>
    </PageContainer>
  );
}
