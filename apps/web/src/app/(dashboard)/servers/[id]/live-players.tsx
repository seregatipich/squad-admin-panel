'use client';
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { useLiveSubscription } from '@/lib/use-live-bus';
import {
  formatTimeOnServer,
  type RosterPlayer,
  type RosterResponse,
  shortEos,
  sortRoster,
  squadLabel,
  teamLabel,
} from './roster-format';

const ROSTER_POLL_MS = 30_000;

export function LivePlayers({ serverId }: { serverId: string }) {
  const [roster, setRoster] = useState<RosterResponse | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [now, setNow] = useState<number>(() => Date.now());

  const load = useCallback(async () => {
    try {
      const resp = await fetch(`/api/v1/servers/${serverId}/roster`, {
        credentials: 'include',
        cache: 'no-store',
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      setRoster((await resp.json()) as RosterResponse);
      setErr(null);
    } catch (loadError) {
      setErr((loadError as Error).message);
    }
  }, [serverId]);

  useEffect(() => {
    void load();
    const timer = setInterval(load, ROSTER_POLL_MS);
    const onVisibility = () => {
      if (document.visibilityState === 'visible') void load();
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [load]);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  const onRoster = useCallback(
    (event: { data: { server_id: string } }) => {
      if (event.data.server_id === serverId) void load();
    },
    [serverId, load],
  );
  useLiveSubscription('rcon.roster', onRoster);

  const players = roster ? sortRoster(roster.players) : [];

  return (
    <section className="rounded border border-neutral-800 bg-neutral-950 p-4">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-xs uppercase tracking-widest text-neutral-400">
          Игроки онлайн{roster ? ` · ${players.length}` : ''}
        </h2>
        <span className="text-[10px] text-neutral-600">обновление каждые 30 с</span>
      </div>

      {err ? (
        <div className="rounded border border-red-900 bg-red-950 p-2 text-xs text-red-300">
          Не удалось загрузить список: {err}
        </div>
      ) : null}

      {roster && players.length === 0 && !err ? (
        <div className="text-xs text-neutral-500">
          Нет игроков онлайн или RCON-опрос ещё не выполнялся.
        </div>
      ) : null}

      {!roster && !err ? <div className="text-xs text-neutral-500">Загрузка…</div> : null}

      {players.length > 0 ? (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-xs">
            <thead>
              <tr className="text-left text-[10px] uppercase tracking-widest text-neutral-500">
                <th className="py-1.5 pr-3 font-medium">Игрок</th>
                <th className="py-1.5 pr-3 font-medium">SteamID64</th>
                <th className="py-1.5 pr-3 font-medium">EOS ID</th>
                <th className="py-1.5 pr-3 font-medium">Команда</th>
                <th className="py-1.5 pr-3 font-medium">Отряд</th>
                <th className="py-1.5 pr-3 font-medium">На сервере</th>
              </tr>
            </thead>
            <tbody>
              {players.map((player) => (
                <RosterRow key={player.eos_id} player={player} now={now} />
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </section>
  );
}

function RosterRow({ player, now }: { player: RosterPlayer; now: number }) {
  return (
    <tr className="border-t border-neutral-900 hover:bg-neutral-900/40">
      <td className="py-1.5 pr-3">
        <span className="flex items-center gap-1.5">
          {player.is_leader ? (
            <span className="text-amber-400" title="Командир отряда">
              ★
            </span>
          ) : null}
          {player.player_id ? (
            <Link href={`/players/${player.player_id}`} className="text-sky-400 hover:text-sky-300">
              {player.name}
            </Link>
          ) : (
            <span className="text-neutral-300">{player.name}</span>
          )}
        </span>
      </td>
      <td className="py-1.5 pr-3 font-mono text-neutral-400">{player.steam_id64 ?? '—'}</td>
      <td className="py-1.5 pr-3 font-mono text-neutral-500" title={player.eos_id}>
        {shortEos(player.eos_id)}
      </td>
      <td className="py-1.5 pr-3 font-mono text-neutral-400">{teamLabel(player.team_id)}</td>
      <td className="py-1.5 pr-3 font-mono text-neutral-400">{squadLabel(player.squad_id)}</td>
      <td className="py-1.5 pr-3 font-mono text-neutral-400">
        {formatTimeOnServer(player.first_seen_at, now)}
      </td>
    </tr>
  );
}
