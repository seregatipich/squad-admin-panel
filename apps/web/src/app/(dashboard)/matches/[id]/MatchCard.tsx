'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import {
  buildMatchCombatLogHref,
  buildMatchDetailHref,
  formatDateTime,
  formatDuration,
  formatKillDeathStat,
  formatMatchStat,
  formatMatchTimelineOffset,
  isOpenMatch,
  liveDurationSeconds,
  type MatchDetail,
  type MatchRosterEntry,
  type MatchRosterSort,
  type MatchRosterSortField,
  type MatchTeamAggregate,
  type MatchTimelineEvent,
  PILL_CLASSES,
  ROSTER_LEFT_EARLY_TITLE,
  rosterRowClass,
  safeMatchBackHref,
  sortMatchRosterEntries,
  teamPillTone,
  winnerLabel,
} from '../helpers';

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
  const listHref = safeMatchBackHref(backHref);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetch(`/api/v1/matches/${matchId}`, { credentials: 'include', cache: 'no-store' })
      .then(async (res) => {
        if (res.status === 404) throw new Error('Матч не найден');
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return (await res.json()) as MatchDetail;
      })
      .then((data) => {
        if (!cancelled) setMatch(data);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError((err as Error).message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [matchId]);

  useEffect(() => {
    if (!match || !isOpenMatch(match)) return;
    const timer = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(timer);
  }, [match]);

  if (loading) return <div className="py-10 text-center text-sm text-neutral-500">Загрузка…</div>;
  if (error || !match) {
    return (
      <div className="space-y-4">
        <Link href={listHref} className="text-sm text-sky-400 hover:text-sky-300">
          ← К списку матчей
        </Link>
        <div className="rounded border border-red-900 bg-red-950 p-3 text-sm text-red-200">
          {error ?? 'Матч не найден'}
        </div>
      </div>
    );
  }

  const open = isOpenMatch(match);
  const interrupted = !open && match.end_reason !== null && match.end_reason !== 'ended';
  const displayedDuration = open
    ? liveDurationSeconds(match.started_at, now)
    : match.duration_seconds;

  return (
    <div className="max-w-4xl space-y-6">
      <Link href={listHref} className="text-sm text-sky-400 hover:text-sky-300">
        ← К списку матчей
      </Link>

      <section className="space-y-4 rounded border border-neutral-800 bg-neutral-950 p-5">
        <div className="flex flex-wrap items-center gap-2">
          <span className="rounded bg-neutral-800 px-2 py-0.5 text-xs text-neutral-200">
            {match.server_name ?? match.server_slug ?? '—'}
          </span>
          {match.is_seed ? (
            <span className="rounded border border-amber-900 bg-amber-950/50 px-2 py-0.5 text-xs text-amber-300">
              Seeding
            </span>
          ) : null}
          {interrupted ? (
            <span className="rounded border border-red-900 bg-red-950/50 px-2 py-0.5 text-xs text-red-300">
              Прерван
            </span>
          ) : null}
          {open ? (
            <span className="inline-flex items-center gap-1 rounded border border-emerald-800 bg-emerald-950/60 px-2 py-0.5 text-xs text-emerald-300">
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-400" />
              Идёт
            </span>
          ) : null}
        </div>

        <div>
          <h1 className="text-xl font-semibold text-neutral-100">{match.layer ?? '—'}</h1>
          {match.game_mode ? <p className="text-sm text-neutral-500">{match.game_mode}</p> : null}
        </div>

        <div className="grid grid-cols-2 gap-4 text-sm sm:grid-cols-4">
          <Field label="Начало" value={formatDateTime(match.started_at)} title={match.started_at} />
          <Field
            label="Конец"
            value={open ? '—' : formatDateTime(match.ended_at)}
            title={match.ended_at}
          />
          <Field label="Длительность" value={formatDuration(displayedDuration)} />
          <Field label="Победитель" value={winnerLabel(match)} />
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <ResultPill
            team={1}
            faction={match.team1_faction}
            tickets={match.team1_tickets}
            winner={match.winner}
          />
          <ResultPill
            team={2}
            faction={match.team2_faction}
            tickets={match.team2_tickets}
            winner={match.winner}
          />
        </div>

        {match.previous_match || match.next_match ? (
          <div className="grid grid-cols-1 gap-2 border-t border-neutral-900 pt-4 text-sm sm:grid-cols-2">
            <AdjacentLink direction="previous" match={match.previous_match} backHref={listHref} />
            <AdjacentLink direction="next" match={match.next_match} backHref={listHref} />
          </div>
        ) : null}
      </section>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
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
      </div>

      <MatchTimeline
        events={match.combat_events}
        startedAt={match.started_at}
        combatLogHref={buildMatchCombatLogHref(match)}
      />
    </div>
  );
}

function Field({ label, value, title }: { label: string; value: string; title?: string | null }) {
  return (
    <div>
      <div className="text-xs uppercase tracking-widest text-neutral-500">{label}</div>
      <div className="text-neutral-200" title={title ?? undefined}>
        {value}
      </div>
    </div>
  );
}

function ResultPill({
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
    <div
      className={`flex items-center justify-between rounded border px-3 py-2 text-sm ${PILL_CLASSES[tone]}`}
    >
      <span>{faction ?? `Команда ${team}`}</span>
      <span className="font-mono text-base">{tickets ?? '—'}</span>
    </div>
  );
}

function AdjacentLink({
  direction,
  match,
  backHref,
}: {
  direction: 'previous' | 'next';
  match: MatchDetail['previous_match'];
  backHref: string;
}) {
  if (!match) {
    return (
      <span className="rounded border border-neutral-900 px-3 py-2 text-neutral-700">
        {direction === 'previous' ? 'Предыдущего матча нет' : 'Следующего матча нет'}
      </span>
    );
  }
  const label = direction === 'previous' ? '← Предыдущий' : 'Следующий →';
  return (
    <Link
      href={buildMatchDetailHref(match.id, backHref)}
      className="rounded border border-neutral-800 px-3 py-2 text-sky-400 hover:border-neutral-700 hover:text-sky-300"
    >
      <span className="block text-xs uppercase tracking-widest text-neutral-500">{label}</span>
      <span className="block truncate">{match.layer ?? formatDateTime(match.started_at)}</span>
    </Link>
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
  const applySort = (field: MatchRosterSortField) => {
    setSort((current) => nextRosterSort(current, field));
  };

  return (
    <section className="rounded border border-neutral-800 bg-neutral-950 p-4">
      <h2 className="mb-3 text-xs uppercase tracking-widest text-neutral-400">
        {title} ({entries.length})
      </h2>
      <div className="mb-3 grid grid-cols-5 gap-2 rounded border border-neutral-900 bg-neutral-900/50 px-3 py-2 text-xs text-neutral-400">
        <StatBlock label="K/D" value={formatKillDeathStat(summary.kills, summary.deaths)} />
        <StatBlock label="TK" value={formatMatchStat(summary.teamkills)} />
        <StatBlock label="Ран." value={formatMatchStat(summary.wounds)} />
        <StatBlock label="Под." value={formatMatchStat(summary.revives)} />
        <StatBlock label="Время" value={formatDuration(summary.play_seconds)} />
      </div>
      {entries.length === 0 ? (
        <p className="text-sm text-neutral-600">Нет данных о составе.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[560px] border-collapse text-sm">
            <thead className="text-left text-[11px] uppercase tracking-widest text-neutral-600">
              <tr>
                <th className="py-2 pr-3 font-medium">
                  <RosterSortHeader field="player" label="Игрок" sort={sort} onSort={applySort} />
                </th>
                <th className="px-2 py-2 font-medium">
                  <RosterSortHeader field="squad" label="Отряд" sort={sort} onSort={applySort} />
                </th>
                <th className="px-2 py-2 text-right font-medium">
                  <RosterSortHeader
                    field="time"
                    label="Время"
                    sort={sort}
                    onSort={applySort}
                    align="right"
                  />
                </th>
                <th className="px-2 py-2 text-right font-medium">
                  <RosterSortHeader
                    field="kd"
                    label="K/D"
                    sort={sort}
                    onSort={applySort}
                    align="right"
                  />
                </th>
                <th className="px-2 py-2 text-right font-medium">
                  <RosterSortHeader
                    field="tk"
                    label="TK"
                    sort={sort}
                    onSort={applySort}
                    align="right"
                  />
                </th>
                <th className="px-2 py-2 text-right font-medium">
                  <RosterSortHeader
                    field="wounds"
                    label="Ран."
                    sort={sort}
                    onSort={applySort}
                    align="right"
                  />
                </th>
                <th className="py-2 pl-2 text-right font-medium">
                  <RosterSortHeader
                    field="revives"
                    label="Под."
                    sort={sort}
                    onSort={applySort}
                    align="right"
                  />
                </th>
              </tr>
            </thead>
            <tbody>
              {sortedEntries.map((entry) => (
                <tr
                  key={entry.player_id}
                  className={rosterRowClass(entry)}
                  title={entry.left_early ? ROSTER_LEFT_EARLY_TITLE : undefined}
                >
                  <td className="max-w-[180px] py-2 pr-3">
                    <Link
                      href={`/players/${entry.player_id}`}
                      className="block truncate text-sky-400 hover:text-sky-300"
                    >
                      {entry.nickname}
                    </Link>
                  </td>
                  <td className="max-w-[150px] truncate px-2 py-2 text-xs text-neutral-500">
                    {entry.squad_name ?? 'Без отряда'}
                  </td>
                  <td className="px-2 py-2 text-right font-mono text-xs text-neutral-500">
                    {formatDuration(entry.play_seconds)}
                  </td>
                  <td className="px-2 py-2 text-right font-mono text-xs text-neutral-300">
                    {formatKillDeathStat(entry.kills, entry.deaths)}
                  </td>
                  <td className="px-2 py-2 text-right font-mono text-xs text-neutral-300">
                    {formatMatchStat(entry.teamkills)}
                  </td>
                  <td className="px-2 py-2 text-right font-mono text-xs text-neutral-300">
                    {formatMatchStat(entry.wounds)}
                  </td>
                  <td className="py-2 pl-2 text-right font-mono text-xs text-neutral-300">
                    {formatMatchStat(entry.revives)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
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

function RosterSortHeader({
  field,
  label,
  sort,
  onSort,
  align = 'left',
}: {
  field: MatchRosterSortField;
  label: string;
  sort: MatchRosterSort | null;
  onSort: (field: MatchRosterSortField) => void;
  align?: 'left' | 'right';
}) {
  const active = sort?.field === field;
  const arrow = active ? (sort.order === 'desc' ? '↓' : '↑') : '';
  return (
    <button
      type="button"
      onClick={() => onSort(field)}
      className={`inline-flex min-w-0 items-center gap-1 border-0 bg-transparent p-0 text-inherit hover:text-neutral-300 ${
        active ? 'text-neutral-200' : ''
      } ${align === 'right' ? 'justify-end' : ''}`}
    >
      <span>{label}</span>
      <span className="w-2 text-[10px]">{arrow}</span>
    </button>
  );
}

function StatBlock({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-widest text-neutral-600">{label}</div>
      <div className="mt-0.5 truncate font-mono text-neutral-200">{value}</div>
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
    <section className="rounded border border-neutral-800 bg-neutral-950 p-4">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-xs uppercase tracking-widest text-neutral-400">Боевые события</h2>
        <Link href={combatLogHref} className="text-sm text-sky-400 hover:text-sky-300">
          Открыть боевой лог
        </Link>
      </div>
      {events === null ? (
        <p className="text-sm text-neutral-600">Нет доступа к боевым событиям.</p>
      ) : events.length === 0 ? (
        <p className="text-sm text-neutral-600">Боевые события не найдены.</p>
      ) : (
        <ol className="space-y-2">
          {events.map((event) => (
            <li
              key={event.id}
              className={`rounded border px-3 py-2 text-sm ${
                event.is_teamkill
                  ? 'border-red-900 bg-red-950/30'
                  : 'border-neutral-900 bg-neutral-900/40'
              }`}
            >
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-mono text-xs text-neutral-500">
                  {formatMatchTimelineOffset(event.occurred_at, startedAt)}
                </span>
                <span
                  className={`rounded px-2 py-0.5 text-xs ${
                    event.is_teamkill
                      ? 'bg-red-900 text-red-200'
                      : event.event_type === 'revive'
                        ? 'bg-emerald-900 text-emerald-200'
                        : event.event_type === 'wound'
                          ? 'bg-orange-900 text-orange-200'
                          : 'bg-neutral-800 text-neutral-200'
                  }`}
                >
                  {event.is_teamkill ? 'Тимкилл' : timelineEventLabel(event.event_type)}
                </span>
                <TimelinePlayer player={event.attacker} />
                <span className="text-neutral-600">→</span>
                <TimelinePlayer player={event.victim} />
              </div>
              {event.weapon || event.attacker_vehicle || event.victim_vehicle ? (
                <div className="mt-1 truncate text-xs text-neutral-500">
                  {[event.weapon, event.attacker_vehicle, event.victim_vehicle]
                    .filter(Boolean)
                    .join(' · ')}
                </div>
              ) : null}
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

function TimelinePlayer({ player }: { player: MatchTimelineEvent['attacker'] }) {
  if (!player) return <span className="text-neutral-500">—</span>;
  return (
    <Link href={`/players/${player.player_id}`} className="text-sky-400 hover:text-sky-300">
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
