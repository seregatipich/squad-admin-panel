'use client';

import Link from 'next/link';
import { memo } from 'react';
import {
  Badge,
  type BadgeTone,
  EmptyState,
  SkeletonTable,
  SortableTh,
  type SortDirection,
  StatusBadge,
  Table,
  TableBody,
  TableHead,
  TableRow,
  Td,
  Th,
} from '@/components/ui';
import {
  buildMatchDetailHref,
  formatDateTime,
  formatDuration,
  isOpenMatch,
  liveDurationSeconds,
  type MatchFilters,
  type MatchListItem,
  type PillTone,
  SORT_COLUMNS,
  type SortField,
  shortServerName,
  teamPillTone,
  winnerLabel,
} from './helpers';

/**
 * Исход команды подкрашивает бейдж с тикетами. Цвет здесь только ускоряет
 * просмотр: кто победил, сказано словами в колонке «Победитель», поэтому строка
 * без подсветки ничего не теряет (дизайн-система, §5).
 */
const TEAM_TONE: Record<PillTone, BadgeTone> = {
  winner: 'good',
  loser: 'crit',
  neutral: 'neutral',
};

/** Как читается направление сортировки колонок списка матчей. */
const SORT_DIRECTION_TEXT: Record<SortDirection, string> = {
  asc: 'по возрастанию',
  desc: 'по убыванию',
};

function TicketBadge({
  team,
  faction,
  tickets,
  winner,
}: {
  team: 1 | 2;
  faction: string | null;
  tickets: number | null;
  winner: MatchListItem['winner'];
}) {
  return (
    <Badge tone={TEAM_TONE[teamPillTone(team, winner)]}>
      <span className="inline-flex items-center gap-1">
        <span className="truncate">{faction ?? `Команда ${team}`}</span>
        <span className="tabular-nums">{tickets ?? '—'}</span>
      </span>
    </Badge>
  );
}

/** Sortable match table with its loading and empty states. */
export function MatchTable({
  items,
  loading,
  filters,
  filtersApplied,
  now,
  onSort,
  onOpen,
  listHref,
}: {
  items: MatchListItem[];
  loading: boolean;
  filters: MatchFilters;
  filtersApplied: boolean;
  now: Date;
  onSort: (column: SortField) => void;
  onOpen: (id: string) => void;
  listHref: string;
}) {
  const columnLabel = (column: SortField) =>
    SORT_COLUMNS.find((entry) => entry.value === column)?.label ?? column;

  if (loading && items.length === 0) {
    return (
      <div className="p-3">
        <SkeletonTable rows={8} cols={8} label="Загрузка списка матчей" />
      </div>
    );
  }
  if (!loading && items.length === 0) {
    return (
      <EmptyState
        variant={filtersApplied ? 'filtered' : 'initial'}
        title={filtersApplied ? 'Нет совпадений.' : 'Матчей ещё не было'}
        description={
          filtersApplied
            ? 'Ни один матч не подходит под включённые фильтры.'
            : 'Панель ещё не записала ни одного матча. Запустите сервер и сыграйте раунд.'
        }
      />
    );
  }

  return (
    <Table ariaLabel="Матчи" className="min-w-[820px]">
      <TableHead>
        <tr>
          <Th>Сервер</Th>
          <SortableTh
            sortKey="layer"
            activeKey={filters.sort}
            direction={filters.order}
            onSort={(key) => onSort(key as SortField)}
            label={columnLabel('layer')}
            directionText={SORT_DIRECTION_TEXT}
          />
          <SortableTh
            sortKey="started_at"
            activeKey={filters.sort}
            direction={filters.order}
            onSort={(key) => onSort(key as SortField)}
            label={columnLabel('started_at')}
            directionText={SORT_DIRECTION_TEXT}
          />
          <Th>Конец</Th>
          <Th>Команда 1</Th>
          <Th>Команда 2</Th>
          <SortableTh
            sortKey="duration_seconds"
            activeKey={filters.sort}
            direction={filters.order}
            onSort={(key) => onSort(key as SortField)}
            label={columnLabel('duration_seconds')}
            directionText={SORT_DIRECTION_TEXT}
            align="right"
          />
          <Th>Победитель</Th>
        </tr>
      </TableHead>
      <TableBody>
        {items.map((match) => (
          <MatchRow key={match.id} match={match} now={now} onOpen={onOpen} listHref={listHref} />
        ))}
      </TableBody>
    </Table>
  );
}

/**
 * One row of {@link MatchTable}, split out and memoized so the once-a-second
 * `now` tick (kept alive while any match is still open) only re-renders the
 * open match's own row instead of the whole table — a closed match's row
 * never reads `now`, so its rendered output cannot change when it ticks.
 */
const MatchRow = memo(
  function MatchRow({
    match,
    now,
    onOpen,
    listHref,
  }: {
    match: MatchListItem;
    now: Date;
    onOpen: (id: string) => void;
    listHref: string;
  }) {
    const open = isOpenMatch(match);
    const duration = open ? liveDurationSeconds(match.started_at, now) : match.duration_seconds;
    return (
      <TableRow interactive>
        <Td>
          <Link
            href={buildMatchDetailHref(match.id, listHref)}
            onClick={() => onOpen(match.id)}
            title={match.server_name ?? undefined}
            className="font-medium text-accent no-underline hover:brightness-110"
          >
            {shortServerName(match)}
          </Link>
        </Td>
        <Td>{match.layer ?? '—'}</Td>
        <Td className="text-xs text-ink-3">{formatDateTime(match.started_at)}</Td>
        <Td className="text-xs text-ink-3">
          {open ? <StatusBadge state="good" label="Идёт" pulse /> : formatDateTime(match.ended_at)}
        </Td>
        <Td>
          <TicketBadge
            team={1}
            faction={match.team1_faction}
            tickets={match.team1_tickets}
            winner={match.winner}
          />
        </Td>
        <Td>
          <TicketBadge
            team={2}
            faction={match.team2_faction}
            tickets={match.team2_tickets}
            winner={match.winner}
          />
        </Td>
        <Td numeric className="text-xs">
          {formatDuration(duration)}
        </Td>
        <Td className="text-xs">{winnerLabel(match)}</Td>
      </TableRow>
    );
  },
  (prev, next) => {
    if (
      prev.match !== next.match ||
      prev.onOpen !== next.onOpen ||
      prev.listHref !== next.listHref
    ) {
      return false;
    }
    // A closed match's cells never depend on `now` — only an open one's
    // "Идёт"/duration cell does, so only that row needs to re-render on tick.
    if (!isOpenMatch(next.match)) return true;
    return prev.now.getTime() === next.now.getTime();
  },
);
