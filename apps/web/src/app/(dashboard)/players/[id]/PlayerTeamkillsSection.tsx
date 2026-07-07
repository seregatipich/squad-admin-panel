'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import {
  buildCombatLogTeamkillHref,
  buildPlayerTeamkillApiPath,
  formatTeamkillCount,
  formatTeamkillDate,
  type TeamkillPlayerEvent,
  type TeamkillPlayerResponse,
} from '../../moderation/teamkills/helpers';

export function PlayerTeamkillsSection({ playerId }: { playerId: string }) {
  const [data, setData] = useState<TeamkillPlayerResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [hidden, setHidden] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setHidden(false);
    setError(null);
    fetch(buildPlayerTeamkillApiPath(playerId), {
      credentials: 'include',
      cache: 'no-store',
    })
      .then(async (res) => {
        if (res.status === 401 || res.status === 403) {
          setHidden(true);
          return null;
        }
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return (await res.json()) as TeamkillPlayerResponse;
      })
      .then((body) => {
        if (!cancelled && body) setData(body);
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
  }, [playerId]);

  if (hidden) return null;

  return (
    <section className="rounded border border-neutral-800 bg-neutral-950 p-4 space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-xs uppercase tracking-widest text-neutral-400">Тимкиллы</h2>
        <Link
          href={buildCombatLogTeamkillHref({ role: 'attacker', playerId })}
          className="text-xs text-sky-400 no-underline hover:text-sky-300"
        >
          Боевой лог
        </Link>
      </div>

      {error ? (
        <div className="rounded border border-red-900 bg-red-950 p-3 text-sm text-red-200">
          Ошибка загрузки тимкиллов: {error}
        </div>
      ) : null}

      {loading && !data ? (
        <div className="py-6 text-center text-sm text-neutral-500">Загрузка…</div>
      ) : data ? (
        <>
          <dl className="grid gap-2 sm:grid-cols-4">
            <Metric label="7 дней" value={data.stats.tk_7d} />
            <Metric label="30 дней" value={data.stats.tk_30d} />
            <Metric label="Всего" value={data.stats.tk_total} />
            <Metric label="Получал TK" value={data.stats.victim_of_tk_total} muted />
          </dl>

          {data.recent.length === 0 ? (
            <div className="rounded border border-dashed border-neutral-800 py-8 text-center text-sm text-neutral-500">
              TK-событий нет.
            </div>
          ) : (
            <ul className="divide-y divide-neutral-900 overflow-hidden rounded border border-neutral-900">
              {data.recent.map((event) => (
                <RecentEvent key={event.id} event={event} playerId={playerId} />
              ))}
            </ul>
          )}
        </>
      ) : null}
    </section>
  );
}

function Metric({
  label,
  value,
  muted = false,
}: {
  label: string;
  value: number;
  muted?: boolean;
}) {
  return (
    <div className="rounded border border-neutral-900 bg-neutral-900/50 p-2">
      <dt className="text-[10px] uppercase tracking-widest text-neutral-500">{label}</dt>
      <dd className={`mt-1 font-mono ${muted ? 'text-neutral-400' : 'text-neutral-100'}`}>
        {formatTeamkillCount(value)}
      </dd>
    </div>
  );
}

function RecentEvent({ event, playerId }: { event: TeamkillPlayerEvent; playerId: string }) {
  const roleLabel = event.role === 'attacker' ? 'нанёс' : 'получил';
  const other = event.role === 'attacker' ? event.victim : event.attacker;
  const logHref = buildCombatLogTeamkillHref({ role: event.role, playerId });

  return (
    <li className="flex flex-wrap items-center justify-between gap-3 bg-neutral-950 px-3 py-2 text-sm">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <span
            className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${
              event.role === 'attacker' ? 'bg-red-950 text-red-200' : 'bg-amber-950 text-amber-200'
            }`}
          >
            {roleLabel}
          </span>
          {other?.player_id ? (
            <Link
              href={`/players/${other.player_id}`}
              className="truncate text-sky-300 no-underline hover:text-sky-200"
            >
              {other.current_name ?? other.player_id.slice(0, 8)}
            </Link>
          ) : (
            <span className="text-neutral-500">неизвестный игрок</span>
          )}
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-3 text-xs text-neutral-500">
          <span>{formatTeamkillDate(event.occurred_at)}</span>
          <span className="font-mono">{event.weapon ?? '—'}</span>
          {event.match_id ? <span className="font-mono">match {event.match_id}</span> : null}
        </div>
      </div>
      <Link href={logHref} className="text-xs text-sky-400 no-underline hover:text-sky-300">
        Лог
      </Link>
    </li>
  );
}
