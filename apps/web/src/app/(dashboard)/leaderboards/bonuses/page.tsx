'use client';

import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Button,
  Card,
  EmptyState,
  InlineBanner,
  PageContainer,
  PageHeader,
  SegmentedControl,
  Skeleton,
  SkeletonTable,
  Table,
  TableBody,
  TableHead,
  TableRow,
  Td,
  Th,
} from '@/components/ui';
import { formatCount, formatDuration, medalFor } from '../helpers';
import {
  BONUS_PERIODS,
  type BonusLeaderboardBody,
  type BonusPeriod,
  buildApiQuery,
  buildQueryString,
  parsePeriod,
  playerHref,
  valueColumnLabel,
} from './helpers';

export default function BonusLeaderboardPage() {
  return (
    <Suspense
      fallback={
        // Заголовок страницы приходит вместе с содержимым: второго `<h1>` на
        // время загрузки быть не должно.
        <PageContainer width="wide">
          <Skeleton variant="text" width="14rem" label="Загрузка лидерборда бонусов" />
          <Card padding="sm">
            <Skeleton variant="row" count={8} />
          </Card>
        </PageContainer>
      }
    >
      <BonusLeaderboardBrowser />
    </Suspense>
  );
}

function BonusLeaderboardBrowser() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const period = useMemo(() => parsePeriod(searchParams), [searchParams]);

  const [data, setData] = useState<BonusLeaderboardBody | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  /**
   * Номер последнего запроса: «Повторить» ходит тем же путём, что и обычная
   * загрузка, а ответ на отменённый запрос в состояние не попадает.
   */
  const requestRef = useRef(0);

  const selectPeriod = useCallback(
    (next: BonusPeriod) => {
      const qs = buildQueryString(next);
      router.replace(qs ? `${pathname}?${qs}` : pathname);
    },
    [pathname, router],
  );

  const load = useCallback(() => {
    requestRef.current += 1;
    const requestId = requestRef.current;
    const current = () => requestRef.current === requestId;
    setLoading(true);
    setError(null);
    fetch(`/api/v1/leaderboards/bonuses?${buildApiQuery(period)}`, {
      credentials: 'include',
      cache: 'no-store',
    })
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return (await res.json()) as BonusLeaderboardBody;
      })
      .then((body) => {
        if (current()) setData(body);
      })
      .catch((err: unknown) => {
        if (current()) setError((err as Error).message);
      })
      .finally(() => {
        if (current()) setLoading(false);
      });
  }, [period]);

  useEffect(() => {
    load();
    return () => {
      requestRef.current += 1;
    };
  }, [load]);

  const rows = data?.rows ?? [];
  const available = data?.available ?? true;

  return (
    <PageContainer width="wide">
      <PageHeader
        title="Лидерборд бонусов"
        backHref="/leaderboards"
        backLabel="К лидербордам"
        meta={available ? <span>всего: {formatCount(data?.total_rows ?? 0)}</span> : undefined}
        actions={
          <SegmentedControl
            ariaLabel="Период начисления"
            items={BONUS_PERIODS.map((entry) => ({ value: entry.value, label: entry.label }))}
            value={period}
            onChange={(value) => selectPeriod(value as BonusPeriod)}
          />
        }
      />

      {error ? (
        <InlineBanner
          tone="crit"
          title="Не удалось загрузить лидерборд бонусов"
          description={error}
          action={
            <Button size="sm" onClick={load}>
              Повторить
            </Button>
          }
        />
      ) : null}

      <Card padding="none">
        {!available && !loading ? (
          <EmptyState
            title="Экономика отключена — лидерборд бонусов недоступен."
            description="Включите экономику в настройках панели, чтобы бонусы начислялись и попадали в рейтинг."
          />
        ) : (
          <BonusTable period={period} rows={rows} loading={loading} />
        )}
      </Card>
    </PageContainer>
  );
}

function BonusTable({
  period,
  rows,
  loading,
}: {
  period: BonusPeriod;
  rows: BonusLeaderboardBody['rows'];
  loading: boolean;
}) {
  if (loading && rows.length === 0) {
    return (
      <div className="p-3">
        <SkeletonTable rows={8} cols={4} label="Загрузка лидерборда бонусов" />
      </div>
    );
  }
  if (!loading && rows.length === 0) {
    return (
      <EmptyState
        title="Пока никто не заработал бонусов."
        description="Бонусы начисляются за время на сервере — рейтинг заполнится сам."
      />
    );
  }

  return (
    <Table ariaLabel="Лидерборд бонусов" className="min-w-[560px]">
      <TableHead>
        <tr>
          <Th align="right">#</Th>
          <Th>Игрок</Th>
          <Th align="right">{valueColumnLabel(period)}</Th>
          <Th align="right">Онлайн</Th>
        </tr>
      </TableHead>
      <TableBody>
        {rows.map((row) => {
          const medal = medalFor(row.rank);
          return (
            <TableRow key={row.player_id} interactive>
              <Td numeric className="text-xs text-ink-3">
                {medal ? (
                  <span className="text-base" title={`Место ${row.rank}`}>
                    {medal}
                  </span>
                ) : (
                  row.rank
                )}
              </Td>
              <Td>
                <a
                  href={playerHref(row)}
                  className="font-medium text-accent no-underline hover:brightness-110"
                >
                  {row.current_name}
                </a>
              </Td>
              <Td numeric className="text-xs">
                {formatCount(row.value)}
              </Td>
              <Td numeric className="text-xs">
                {formatDuration(row.online_seconds)}
              </Td>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}
