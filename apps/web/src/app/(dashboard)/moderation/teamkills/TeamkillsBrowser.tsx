'use client';

import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Button,
  ButtonLink,
  Card,
  EmptyState,
  InlineBanner,
  PageContainer,
  PageHeader,
  Select,
  SkeletonTable,
  SortableTh,
  Table,
  TableBody,
  TableCaption,
  TableHead,
  TableRow,
  Td,
  Th,
  Toolbar,
} from '@/components/ui';
import {
  buildCombatLogTeamkillHref,
  buildTeamkillQueryString,
  buildTeamkillSummaryApiQuery,
  formatModerationSummary,
  formatTeamkillCount,
  formatTeamkillDate,
  parseTeamkillFilters,
  type TeamkillFilters,
  type TeamkillSort,
  type TeamkillSummaryResponse,
  type TeamkillSummaryRow,
  teamkillSortLabel,
} from './helpers';

interface ServerOption {
  id: string;
  display_name: string | null;
  slug: string | null;
}

interface ServersResponse {
  items: ServerOption[];
}

/** Подписи направления для `SortableTh`: примитивы не читают словарь переводов. */
const SORT_DIRECTION_TEXT = { asc: 'по возрастанию', desc: 'по убыванию' } as const;

export function TeamkillsBrowser() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const filters = useMemo(() => parseTeamkillFilters(searchParams), [searchParams]);

  const [servers, setServers] = useState<ServerOption[]>([]);
  const [data, setData] = useState<TeamkillSummaryResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const navigate = useCallback(
    (partial: Partial<TeamkillFilters>) => {
      const next: TeamkillFilters = { ...filters, ...partial };
      const qs = buildTeamkillQueryString(next);
      router.replace(qs ? `${pathname}?${qs}` : pathname);
    },
    [filters, pathname, router],
  );

  useEffect(() => {
    let cancelled = false;
    fetch('/api/v1/servers', { credentials: 'include', cache: 'no-store' })
      .then(async (res) => (res.ok ? ((await res.json()) as ServersResponse) : { items: [] }))
      .then((body) => {
        if (!cancelled) setServers(body.items ?? []);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  // Отдельная функция, а не тело эффекта: тот же запрос повторяет кнопка
  // «Повторить» в полосе ошибки, и фильтры при этом не меняются.
  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/v1/moderation/teamkills?${buildTeamkillSummaryApiQuery(filters)}`,
        { credentials: 'include', cache: 'no-store' },
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setData((await res.json()) as TeamkillSummaryResponse);
    } catch (err) {
      setData(null);
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [filters]);

  useEffect(() => {
    void load();
  }, [load]);

  const rows = data?.rows ?? [];
  const filtered = filters.serverId !== 'all';

  return (
    <PageContainer>
      <PageHeader
        title="Тимкиллы"
        meta={<span>Обновлено: {formatTeamkillDate(data?.generated_at ?? null)}</span>}
        actions={
          <ButtonLink href="/combat-log?facet=teamkills" size="md">
            Боевой лог
          </ButtonLink>
        }
      />

      <Toolbar
        filters={
          <Select
            aria-label="Сервер"
            value={filters.serverId}
            onChange={(event) => navigate({ serverId: event.target.value })}
          >
            <option value="all">Все серверы</option>
            {servers.map((server) => (
              <option key={server.id} value={server.id}>
                {server.display_name ?? server.slug ?? server.id.slice(0, 8)}
              </option>
            ))}
          </Select>
        }
        summary={rows.length > 0 ? `Найдено: ${formatTeamkillCount(rows.length)}` : undefined}
      />

      {error ? (
        <InlineBanner
          tone="crit"
          title="Не удалось загрузить тимкиллы"
          description={error}
          action={
            <Button size="sm" onClick={() => void load()}>
              Повторить
            </Button>
          }
        />
      ) : null}

      <TeamkillTable
        rows={rows}
        loading={loading}
        filtered={filtered}
        filters={filters}
        onResetFilters={() => navigate({ serverId: 'all' })}
        onSort={(sort) => {
          const order = filters.sort === sort && filters.order === 'desc' ? 'asc' : 'desc';
          navigate({ sort, order });
        }}
      />
    </PageContainer>
  );
}

function TeamkillTable({
  rows,
  loading,
  filtered,
  filters,
  onResetFilters,
  onSort,
}: {
  rows: TeamkillSummaryRow[];
  loading: boolean;
  /** Выдача сужена фильтром — от этого зависит текст пустого состояния. */
  filtered: boolean;
  filters: TeamkillFilters;
  onResetFilters: () => void;
  onSort: (sort: TeamkillSort) => void;
}) {
  if (loading && rows.length === 0) {
    return (
      <Card padding="sm">
        <SkeletonTable rows={8} cols={6} label="Загрузка тимкиллов" />
      </Card>
    );
  }

  if (!loading && rows.length === 0) {
    return (
      <Card padding="none">
        {filtered ? (
          <EmptyState
            variant="filtered"
            title="Ничего не нашлось"
            description="На выбранном сервере тимкиллов за период нет."
            action={
              <Button size="sm" onClick={onResetFilters}>
                Сбросить фильтр
              </Button>
            }
          />
        ) : (
          <EmptyState
            title="Тимкиллов нет"
            description="Как только сервер сообщит об убийстве союзника, нарушитель появится в этом списке."
          />
        )}
      </Card>
    );
  }

  return (
    <Card padding="none">
      <Table ariaLabel="Нарушители по тимкиллам">
        <TableCaption>
          Нарушители, упорядоченные по колонке «{teamkillSortLabel(filters.sort)}».
        </TableCaption>
        <TableHead>
          <TableRow>
            <Th>Игрок</Th>
            <SortableTh
              sortKey="tk_7d"
              activeKey={filters.sort}
              direction={filters.order}
              onSort={(key) => onSort(key as TeamkillSort)}
              label={teamkillSortLabel('tk_7d')}
              directionText={SORT_DIRECTION_TEXT}
              align="right"
            />
            <SortableTh
              sortKey="tk_30d"
              activeKey={filters.sort}
              direction={filters.order}
              onSort={(key) => onSort(key as TeamkillSort)}
              label={teamkillSortLabel('tk_30d')}
              directionText={SORT_DIRECTION_TEXT}
              align="right"
            />
            <SortableTh
              sortKey="total"
              activeKey={filters.sort}
              direction={filters.order}
              onSort={(key) => onSort(key as TeamkillSort)}
              label={teamkillSortLabel('total')}
              directionText={SORT_DIRECTION_TEXT}
              align="right"
            />
            <Th align="right">Получал TK</Th>
            <Th>Последний TK</Th>
            <Th>Модерация</Th>
            <Th>Переходы</Th>
          </TableRow>
        </TableHead>
        <TableBody>
          {rows.map((row) => (
            <TableRow key={row.player_id} interactive>
              <Td>
                <Link
                  href={`/all-players/${row.player_id}`}
                  className="font-medium text-accent no-underline hover:brightness-110"
                >
                  {row.current_name ?? row.player_id.slice(0, 8)}
                </Link>
                <div className="font-mono text-2xs text-ink-3">
                  {row.steam_id64 ?? row.eos_id ?? row.player_id}
                </div>
              </Td>
              <Td numeric>{formatTeamkillCount(row.tk_7d)}</Td>
              <Td numeric>{formatTeamkillCount(row.tk_30d)}</Td>
              <Td numeric>{formatTeamkillCount(row.tk_total)}</Td>
              <Td numeric className="text-ink-3">
                {formatTeamkillCount(row.victim_of_tk_total)}
              </Td>
              <Td className="whitespace-nowrap text-xs text-ink-2">
                {formatTeamkillDate(row.last_tk_at)}
              </Td>
              <Td
                className={`whitespace-nowrap text-xs ${
                  row.moderation_total > 0 ? 'text-warn' : 'text-ink-3'
                }`}
              >
                {formatModerationSummary(row)}
              </Td>
              <Td>
                <Link
                  href={buildCombatLogTeamkillHref({
                    role: 'attacker',
                    playerId: row.player_id,
                  })}
                  className="text-xs text-accent no-underline hover:brightness-110"
                >
                  Боевой лог
                </Link>
              </Td>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </Card>
  );
}
