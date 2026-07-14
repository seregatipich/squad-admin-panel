'use client';
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { BanNickButton } from '@/components/BannedNameRuleModal';
import { SquadMessageModal, type SquadMessageTarget } from '@/components/SquadMessageModal';
import { useLiveSubscription } from '@/lib/use-live-bus';
import {
  formatTimeOnServer,
  groupRosterBySquad,
  type RosterPlayer,
  type RosterResponse,
  type SquadGroup,
  shortEos,
  sortRoster,
  squadLabel,
  teamLabel,
} from './roster-format';

const ROSTER_POLL_MS = 30_000;

export function LivePlayers({
  serverId,
  canChat = false,
  canBan = false,
}: {
  serverId: string;
  /** Shows the per-squad "message" button. Hidden without the 'chat' squad permission. */
  canChat?: boolean;
  /** Shows the per-player «Забанить ник» button. Hidden without the 'ban' squad permission. */
  canBan?: boolean;
}) {
  const [roster, setRoster] = useState<RosterResponse | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [now, setNow] = useState<number>(() => Date.now());
  const [squadTarget, setSquadTarget] = useState<SquadMessageTarget | null>(null);

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
  const groups = groupRosterBySquad(players);

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
                {canBan ? <th className="py-1.5 pr-3 font-medium"></th> : null}
              </tr>
            </thead>
            <tbody>
              {groups.map((group) => (
                <SquadGroupRows
                  key={`${group.team_id}:${group.squad_id}`}
                  group={group}
                  now={now}
                  serverId={serverId}
                  canChat={canChat}
                  canBan={canBan}
                  onMessageSquad={setSquadTarget}
                />
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      <SquadMessageModal
        target={squadTarget}
        onOpenChange={(open) => !open && setSquadTarget(null)}
      />
    </section>
  );
}

function SquadGroupRows({
  group,
  now,
  serverId,
  canChat,
  canBan,
  onMessageSquad,
}: {
  group: SquadGroup;
  now: number;
  serverId: string;
  canChat: boolean;
  canBan: boolean;
  onMessageSquad: (target: SquadMessageTarget) => void;
}) {
  const messageable = canChat && group.team_id != null && group.squad_id != null;
  const label =
    group.squad_id != null
      ? `Команда ${teamLabel(group.team_id)} · Отряд ${squadLabel(group.squad_id)}`
      : `Команда ${teamLabel(group.team_id)} · Без отряда`;
  const colSpan = canBan ? 7 : 6;

  return (
    <>
      <tr className="border-t border-neutral-800 bg-neutral-900/60">
        <th
          colSpan={colSpan}
          className="py-1 pr-3 text-left text-[10px] font-medium text-neutral-400"
        >
          <div className="flex items-center justify-between">
            <span>
              {label} <span className="text-neutral-600">· {group.players.length}</span>
            </span>
            {messageable ? (
              <button
                type="button"
                title={`Сообщение отряду: ${label}`}
                aria-label={`Сообщение отряду: ${label}`}
                onClick={() =>
                  onMessageSquad({
                    serverId,
                    // biome-ignore lint/style/noNonNullAssertion: guarded by `messageable`
                    teamId: group.team_id!,
                    // biome-ignore lint/style/noNonNullAssertion: guarded by `messageable`
                    squadId: group.squad_id!,
                    label,
                    leaderName: group.leader?.name ?? null,
                  })
                }
                className="rounded px-1.5 py-0.5 text-sky-400 hover:bg-neutral-800 hover:text-sky-300"
              >
                ✉
              </button>
            ) : null}
          </div>
        </th>
      </tr>
      {group.players.map((player) => (
        <RosterRow key={player.eos_id} player={player} now={now} canBan={canBan} />
      ))}
    </>
  );
}

function RosterRow({
  player,
  now,
  canBan,
}: {
  player: RosterPlayer;
  now: number;
  canBan: boolean;
}) {
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
      {canBan ? (
        <td className="py-1.5 pr-3">
          <BanNickButton
            nick={player.name}
            canBan={canBan}
            className="rounded border border-red-900 px-1.5 py-0.5 text-[10px] text-red-400 hover:border-red-700"
          />
        </td>
      ) : null}
    </tr>
  );
}
