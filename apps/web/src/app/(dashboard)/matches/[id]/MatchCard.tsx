'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import {
  formatDateTime,
  formatDuration,
  isOpenMatch,
  type MatchDetail,
  type MatchRosterEntry,
  PILL_CLASSES,
  teamPillTone,
  winnerLabel,
} from '../helpers';

export function MatchCard({ matchId }: { matchId: string }) {
  const [match, setMatch] = useState<MatchDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

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

  if (loading) return <div className="py-10 text-center text-sm text-neutral-500">Загрузка…</div>;
  if (error || !match) {
    return (
      <div className="space-y-4">
        <Link href="/matches" className="text-sm text-sky-400 hover:text-sky-300">
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

  return (
    <div className="max-w-4xl space-y-6">
      <Link href="/matches" className="text-sm text-sky-400 hover:text-sky-300">
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
          <Field label="Начало" value={formatDateTime(match.started_at)} />
          <Field label="Конец" value={open ? '—' : formatDateTime(match.ended_at)} />
          <Field label="Длительность" value={formatDuration(match.duration_seconds)} />
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
      </section>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <RosterColumn
          title={match.team1_faction ?? 'Команда 1'}
          entries={match.roster.filter((entry) => entry.team === 1)}
        />
        <RosterColumn
          title={match.team2_faction ?? 'Команда 2'}
          entries={match.roster.filter((entry) => entry.team === 2)}
        />
      </div>
    </div>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-xs uppercase tracking-widest text-neutral-500">{label}</div>
      <div className="text-neutral-200">{value}</div>
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

function RosterColumn({ title, entries }: { title: string; entries: MatchRosterEntry[] }) {
  return (
    <section className="rounded border border-neutral-800 bg-neutral-950 p-4">
      <h2 className="mb-3 text-xs uppercase tracking-widest text-neutral-400">
        {title} ({entries.length})
      </h2>
      {entries.length === 0 ? (
        <p className="text-sm text-neutral-600">Нет данных о составе.</p>
      ) : (
        <ul className="space-y-1">
          {entries.map((entry) => (
            <li
              key={entry.player_id}
              className="flex items-center justify-between gap-2 border-b border-neutral-900 py-1 text-sm last:border-0"
            >
              <Link
                href={`/players/${entry.player_id}`}
                className="truncate text-sky-400 hover:text-sky-300"
              >
                {entry.nickname}
              </Link>
              <span className="shrink-0 text-xs text-neutral-500">
                {entry.squad_name ?? 'Без отряда'} · {formatDuration(entry.play_seconds)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
