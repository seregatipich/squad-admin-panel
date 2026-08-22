'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Badge,
  type BadgeTone,
  Button,
  Card,
  CardBody,
  CardGrid,
  CardHeader,
  EmptyState,
  GroupedList,
  GroupedRow,
  InlineBanner,
  PageContainer,
  PageHeader,
  Skeleton,
  SortableTh,
  type SortDirection,
  StatTile,
  type StatTileTone,
  StatusBadge,
  Table,
  TableBody,
  TableHead,
  TableRow,
  Td,
} from '@/components/ui';
import {
  buildMatchCombatLogHref,
  buildMatchDetailHref,
  formatDateTime,
  formatDuration,
  formatKillDeathStat,
  formatMatchStat,
  formatMatchTimelineOffset,
  isDimmedRosterEntry,
  isOpenMatch,
  liveDurationSeconds,
  type MatchDetail,
  type MatchRosterEntry,
  type MatchRosterSort,
  type MatchRosterSortField,
  type MatchTeamAggregate,
  type MatchTimelineEvent,
  type PillTone,
  safeMatchBackHref,
  sortMatchRosterEntries,
  teamPillTone,
  winnerLabel,
} from '../helpers';

/**
 * Исход команды красит значение плитки. Цвет здесь только ускоряет просмотр:
 * что именно случилось с командой, сказано словом в подсказке под тикетами
 * (дизайн-система, §5).
 */
const TEAM_TONE: Record<PillTone, StatTileTone> = {
  winner: 'good',
  loser: 'crit',
  neutral: 'neutral',
};

const TEAM_OUTCOME: Record<PillTone, string> = {
  winner: 'Победа',
  loser: 'Поражение',
  neutral: 'Исход не определён',
};

/** Как читается направление сортировки колонок состава. */
const SORT_DIRECTION_TEXT: Record<SortDirection, string> = {
  asc: 'по возрастанию',
  desc: 'по убыванию',
};

/**
 * Тип боевого события. Оттенки здесь различают соседние категории, а не
 * состояние системы: смысл несёт подпись внутри бейджа (§5).
 */
const EVENT_TONE: Record<string, BadgeTone> = {
  revive: 'good',
  wound: 'warn',
};

export function MatchCard({
  matchId,
  backHref = '/matches',
}: {
  matchId: string;
  backHref?: string;
}) {
  const [match, setMatch] = useState<MatchDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [now, setNow] = useState<Date>(() => new Date());
  /**
   * Номер последнего запроса матча: «Повторить» ходит тем же путём, что и
   * первая загрузка, а ответ на отменённый запрос в состояние не попадает.
   */
  const requestRef = useRef(0);
  const listHref = safeMatchBackHref(backHref);

  const load = useCallback(() => {
    requestRef.current += 1;
    const requestId = requestRef.current;
    const current = () => requestRef.current === requestId;
    setLoading(true);
    setError(null);
    fetch(`/api/v1/matches/${matchId}`, { credentials: 'include', cache: 'no-store' })
      .then(async (res) => {
        if (res.status === 404) throw new Error('Матч не найден');
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return (await res.json()) as MatchDetail;
      })
      .then((data) => {
        if (current()) setMatch(data);
      })
      .catch((err: unknown) => {
        if (current()) setError((err as Error).message);
      })
      .finally(() => {
        if (current()) setLoading(false);
      });
  }, [matchId]);

  useEffect(() => {
    load();
    return () => {
      requestRef.current += 1;
    };
  }, [load]);

  useEffect(() => {
    if (!match || !isOpenMatch(match)) return;
    const timer = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(timer);
  }, [match]);

  if (loading) {
    return (
      <PageContainer width="wide">
        <Skeleton variant="text" width="16rem" label="Загрузка матча" />
        <Skeleton variant="card" />
        <Skeleton variant="card" count={2} />
      </PageContainer>
    );
  }

  if (error || !match) {
    return (
      <PageContainer width="wide">
        <PageHeader title="Матч" backHref={listHref} backLabel="К списку матчей" />
        <InlineBanner
          tone="crit"
          title="Не удалось открыть матч"
          description={error ?? 'Матч не найден'}
          action={
            <Button size="sm" onClick={load}>
              Повторить
            </Button>
          }
        />
      </PageContainer>
    );
  }

  const open = isOpenMatch(match);
  const interrupted = !open && match.end_reason !== null && match.end_reason !== 'ended';
  const displayedDuration = open
    ? liveDurationSeconds(match.started_at, now)
    : match.duration_seconds;

  return (
    <PageContainer width="wide">
      <PageHeader
        title={match.layer ?? '—'}
        subtitle={match.game_mode ?? undefined}
        backHref={listHref}
        backLabel="К списку матчей"
        status={open ? <StatusBadge state="good" label="Идёт" pulse /> : undefined}
        meta={
          <>
            <span>{match.server_name ?? match.server_slug ?? '—'}</span>
            {match.is_seed ? (
              <Badge tone="warn" size="sm">
                Seeding
              </Badge>
            ) : null}
            {interrupted ? (
              <Badge tone="crit" size="sm">
                Прерван
              </Badge>
            ) : null}
          </>
        }
      />

      <Card>
        <dl className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          <Field label="Начало" value={formatDateTime(match.started_at)} title={match.started_at} />
          <Field
            label="Конец"
            value={open ? '—' : formatDateTime(match.ended_at)}
            title={match.ended_at}
          />
          <Field label="Длительность" value={formatDuration(displayedDuration)} />
          <Field label="Победитель" value={winnerLabel(match)} />
        </dl>
      </Card>

      <CardGrid cols={2}>
        <TeamResult
          team={1}
          faction={match.team1_faction}
          tickets={match.team1_tickets}
          winner={match.winner}
        />
        <TeamResult
          team={2}
          faction={match.team2_faction}
          tickets={match.team2_tickets}
          winner={match.winner}
        />
      </CardGrid>

      {match.previous_match || match.next_match ? (
        <GroupedList title="Соседние матчи">
          <AdjacentRow direction="previous" match={match.previous_match} backHref={listHref} />
          <AdjacentRow direction="next" match={match.next_match} backHref={listHref} />
        </GroupedList>
      ) : null}

      <CardGrid cols={2}>
        <RosterColumn
          title={match.team1_faction ?? 'Команда 1'}
          entries={match.roster.filter((entry) => entry.team === 1)}
          summary={match.teams.team1}
        />
        <RosterColumn
          title={match.team2_faction ?? 'Команда 2'}
          entries={match.roster.filter((entry) => entry.team === 2)}
          summary={match.teams.team2}
        />
      </CardGrid>

      <MatchTimeline
        events={match.combat_events}
        startedAt={match.started_at}
        combatLogHref={buildMatchCombatLogHref(match)}
      />
    </PageContainer>
  );
}

/** Служебный ярлык над значением — единственное место, где разрешён капслок (§1). */
function Field({ label, value, title }: { label: string; value: string; title?: string | null }) {
  return (
    <div className="flex flex-col gap-1">
      <dt className="text-2xs uppercase tracking-[0.06em] text-ink-3">{label}</dt>
      <dd className="text-[13px] text-ink" title={title ?? undefined}>
        {value}
      </dd>
    </div>
  );
}

function TeamResult({
  team,
  faction,
  tickets,
  winner,
}: {
  team: 1 | 2;
  faction: string | null;
  tickets: number | null;
  winner: MatchDetail['winner'];
}) {
  const tone = teamPillTone(team, winner);
  return (
    <StatTile
      label={faction ?? `Команда ${team}`}
      value={tickets ?? '—'}
      hint={TEAM_OUTCOME[tone]}
      tone={TEAM_TONE[tone]}
    />
  );
}

function AdjacentRow({
  direction,
  match,
  backHref,
}: {
  direction: 'previous' | 'next';
  match: MatchDetail['previous_match'];
  backHref: string;
}) {
  const label = direction === 'previous' ? 'Предыдущий матч' : 'Следующий матч';
  if (!match) {
    return <GroupedRow label={label} control={<span className="text-xs text-ink-3">нет</span>} />;
  }
  return (
    <GroupedRow
      label={label}
      description={match.layer ?? formatDateTime(match.started_at)}
      href={buildMatchDetailHref(match.id, backHref)}
    />
  );
}

function RosterColumn({
  title,
  entries,
  summary,
}: {
  title: string;
  entries: MatchRosterEntry[];
  summary: MatchTeamAggregate;
}) {
  const [sort, setSort] = useState<MatchRosterSort | null>(null);
  const sortedEntries = useMemo(() => sortMatchRosterEntries(entries, sort), [entries, sort]);
  const applySort = (field: string) => {
    setSort((current) => nextRosterSort(current, field as MatchRosterSortField));
  };
  const sortHead = (field: MatchRosterSortField, label: string, align: 'left' | 'right') => (
    <SortableTh
      sortKey={field}
      activeKey={sort?.field ?? null}
      direction={sort?.order ?? 'desc'}
      onSort={applySort}
      label={label}
      directionText={SORT_DIRECTION_TEXT}
      align={align}
    />
  );

  return (
    <Card padding="none">
      <CardHeader title={title} count={entries.length} />
      <CardBody padding="sm">
        <dl className="grid grid-cols-5 gap-2 rounded-ctl bg-raised px-3 py-2">
          <StatBlock label="K/D" value={formatKillDeathStat(summary.kills, summary.deaths)} />
          <StatBlock label="TK" value={formatMatchStat(summary.teamkills)} />
          <StatBlock label="Ранения" value={formatMatchStat(summary.wounds)} />
          <StatBlock label="Поднятия" value={formatMatchStat(summary.revives)} />
          <StatBlock label="Время" value={formatDuration(summary.play_seconds)} />
        </dl>
      </CardBody>
      {entries.length === 0 ? (
        <EmptyState
          title="Нет данных о составе"
          description="Панель не записала, кто играл за эту команду."
        />
      ) : (
        <Table ariaLabel={`Состав команды ${title}`} className="min-w-[560px]" dense>
          <TableHead sticky={false}>
            <tr>
              {sortHead('player', 'Игрок', 'left')}
              {sortHead('squad', 'Отряд', 'left')}
              {sortHead('time', 'Время', 'right')}
              {sortHead('kd', 'K/D', 'right')}
              {sortHead('tk', 'TK', 'right')}
              {sortHead('wounds', 'Ранения', 'right')}
              {sortHead('revives', 'Поднятия', 'right')}
            </tr>
          </TableHead>
          <TableBody>
            {sortedEntries.map((entry) => {
              const leftEarly = isDimmedRosterEntry(entry);
              return (
                <TableRow key={entry.player_id} className={leftEarly ? 'opacity-50' : undefined}>
                  <Td className="max-w-[180px]">
                    <span className="flex min-w-0 items-center gap-1.5">
                      <Link
                        href={`/all-players/${entry.player_id}`}
                        className="truncate text-accent no-underline hover:brightness-110"
                      >
                        {entry.nickname}
                      </Link>
                      {/* Приглушённая строка обязана называть своё состояние
                          словами, а не одной лишь прозрачностью (§5). */}
                      {leftEarly ? (
                        <Badge tone="neutral" size="sm">
                          ушёл раньше
                        </Badge>
                      ) : null}
                    </span>
                  </Td>
                  <Td truncate className="max-w-[150px] text-xs text-ink-3">
                    {entry.squad_name ?? 'Без отряда'}
                  </Td>
                  <Td numeric className="text-xs text-ink-3">
                    {formatDuration(entry.play_seconds)}
                  </Td>
                  <Td numeric className="text-xs">
                    {formatKillDeathStat(entry.kills, entry.deaths)}
                  </Td>
                  <Td numeric className="text-xs">
                    {formatMatchStat(entry.teamkills)}
                  </Td>
                  <Td numeric className="text-xs">
                    {formatMatchStat(entry.wounds)}
                  </Td>
                  <Td numeric className="text-xs">
                    {formatMatchStat(entry.revives)}
                  </Td>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      )}
    </Card>
  );
}

function nextRosterSort(
  current: MatchRosterSort | null,
  field: MatchRosterSortField,
): MatchRosterSort {
  if (current?.field === field) {
    return { field, order: current.order === 'desc' ? 'asc' : 'desc' };
  }
  return { field, order: field === 'player' || field === 'squad' ? 'asc' : 'desc' };
}

/** Служебный ярлык над значением — капслок допустим только здесь (§1). */
function StatBlock({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-2xs uppercase tracking-[0.06em] text-ink-3">{label}</dt>
      <dd className="mt-0.5 truncate text-xs tabular-nums text-ink">{value}</dd>
    </div>
  );
}

export function MatchTimeline({
  events,
  startedAt,
  combatLogHref,
}: {
  events: MatchTimelineEvent[] | null;
  startedAt: string;
  combatLogHref: string;
}) {
  return (
    <Card padding="none">
      <CardHeader
        title="Боевые события"
        actions={
          <Link
            href={combatLogHref}
            className="text-xs text-accent no-underline hover:brightness-110"
          >
            Открыть боевой лог
          </Link>
        }
      />
      {events === null ? (
        <EmptyState
          title="Нет доступа к боевым событиям."
          description="Права вашей роли не включают чтение боевого лога."
        />
      ) : events.length === 0 ? (
        <EmptyState
          title="Боевые события не найдены."
          description="За этот матч панель не записала ни одного боевого события."
        />
      ) : (
        <CardBody padding="sm">
          <ol className="space-y-2">
            {events.map((event) => (
              <li
                key={event.id}
                className={`rounded-ctl border px-3 py-2 ${
                  event.is_teamkill ? 'border-crit/40 bg-crit/10' : 'border-line bg-raised/40'
                }`}
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-xs tabular-nums text-ink-3">
                    {formatMatchTimelineOffset(event.occurred_at, startedAt)}
                  </span>
                  <Badge
                    tone={event.is_teamkill ? 'crit' : (EVENT_TONE[event.event_type] ?? 'neutral')}
                  >
                    {event.is_teamkill ? 'Тимкилл' : timelineEventLabel(event.event_type)}
                  </Badge>
                  <TimelinePlayer player={event.attacker} />
                  <span aria-hidden="true" className="text-ink-3">
                    →
                  </span>
                  <TimelinePlayer player={event.victim} />
                </div>
                {event.weapon || event.attacker_vehicle || event.victim_vehicle ? (
                  <p className="mt-1 truncate text-xs text-ink-3">
                    {[event.weapon, event.attacker_vehicle, event.victim_vehicle]
                      .filter(Boolean)
                      .join(' · ')}
                  </p>
                ) : null}
              </li>
            ))}
          </ol>
        </CardBody>
      )}
    </Card>
  );
}

function TimelinePlayer({ player }: { player: MatchTimelineEvent['attacker'] }) {
  if (!player) return <span className="text-ink-3">—</span>;
  return (
    <Link
      href={`/all-players/${player.player_id}`}
      className="text-accent no-underline hover:brightness-110"
    >
      {player.current_name ?? player.player_id.slice(0, 8)}
    </Link>
  );
}

function timelineEventLabel(eventType: string): string {
  if (eventType === 'death') return 'Убийство';
  if (eventType === 'wound') return 'Ранение';
  if (eventType === 'revive') return 'Поднятие';
  if (eventType === 'vehicle_destroyed') return 'Техника';
  return eventType;
}
