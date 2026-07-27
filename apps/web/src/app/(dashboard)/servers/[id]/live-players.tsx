'use client';
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { BanNickButton } from '@/components/BannedNameRuleModal';
import { BulkModerationModal, type BulkModerationTarget } from '@/components/BulkModerationModal';
import { DirectMessageButton } from '@/components/DirectMessageModal';
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

const BULK_KEYS = ['mod:warn', 'mod:kick', 'mod:ban_temp', 'mod:ban_perm'] as const;

export function LivePlayers({
  serverId,
  canChat = false,
  canBan = false,
  modPermissions = [],
}: {
  serverId: string;
  /** Shows the per-squad "message" button. Hidden without the 'chat' squad permission. */
  canChat?: boolean;
  /** Shows the per-player «Забанить ник» button. Hidden without the 'ban' squad permission. */
  canBan?: boolean;
  /**
   * The caller's `mod:*` catalog keys from `GET /api/v1/me` (MOD-4, #61).
   * Multi-select and the bulk action bar stay hidden unless at least one of
   * them is present; the API enforces the same keys independently.
   */
  modPermissions?: readonly string[];
}) {
  const [roster, setRoster] = useState<RosterResponse | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [now, setNow] = useState<number>(() => Date.now());
  const [squadTarget, setSquadTarget] = useState<SquadMessageTarget | null>(null);
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());
  const [bulkOpen, setBulkOpen] = useState(false);

  const canBulk = BULK_KEYS.some((key) => modPermissions.includes(key));

  const toggleSelected = useCallback((playerId: string) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(playerId)) next.delete(playerId);
      else next.add(playerId);
      return next;
    });
  }, []);

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
  // Only roster entries resolved to a panel player can be bulk-targeted —
  // the API takes player uuids, not roster slots.
  const selectable: BulkModerationTarget[] = players.flatMap((player) =>
    player.player_id ? [{ playerId: player.player_id, name: player.name }] : [],
  );
  const bulkTargets = selectable.filter((target) => selected.has(target.playerId));
  const allSelected = selectable.length > 0 && bulkTargets.length === selectable.length;

  return (
    <section className="rounded border border-neutral-800 bg-neutral-950 p-4">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-xs uppercase tracking-widest text-neutral-400">
          Игроки онлайн{roster ? ` · ${players.length}` : ''}
        </h2>
        <span className="text-[10px] text-neutral-600">обновление каждые 30 с</span>
      </div>

      {canBulk && bulkTargets.length > 0 ? (
        <div className="mb-3 flex flex-wrap items-center gap-2 rounded border border-amber-900 bg-amber-950/40 px-3 py-2">
          <span className="text-xs text-amber-200">Выбрано: {bulkTargets.length}</span>
          <button
            type="button"
            onClick={() => setBulkOpen(true)}
            className="rounded bg-red-700 px-2 py-1 text-xs font-medium text-white hover:bg-red-600"
          >
            Массовое действие
          </button>
          <button
            type="button"
            onClick={() => setSelected(new Set())}
            className="rounded border border-neutral-800 bg-neutral-900 px-2 py-1 text-xs text-neutral-300 hover:border-neutral-700"
          >
            Снять выделение
          </button>
        </div>
      ) : null}

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
                {canBulk ? (
                  <th className="py-1.5 pr-2 font-medium">
                    <input
                      type="checkbox"
                      aria-label="Выделить всех"
                      checked={allSelected}
                      onChange={() =>
                        setSelected(
                          allSelected
                            ? new Set()
                            : new Set(selectable.map((target) => target.playerId)),
                        )
                      }
                      className="align-middle accent-red-600"
                    />
                  </th>
                ) : null}
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
                  canBulk={canBulk}
                  selected={selected}
                  onToggleSelected={toggleSelected}
                  onSelectGroup={setSelected}
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

      <BulkModerationModal
        serverId={serverId}
        targets={bulkOpen ? bulkTargets : null}
        permissions={modPermissions}
        onOpenChange={(open) => {
          if (!open) setBulkOpen(false);
        }}
        onApplied={() => {
          setSelected(new Set());
          void load();
        }}
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
  canBulk,
  selected,
  onToggleSelected,
  onSelectGroup,
  onMessageSquad,
}: {
  group: SquadGroup;
  now: number;
  serverId: string;
  canChat: boolean;
  canBan: boolean;
  canBulk: boolean;
  selected: ReadonlySet<string>;
  onToggleSelected: (playerId: string) => void;
  onSelectGroup: (update: (current: ReadonlySet<string>) => ReadonlySet<string>) => void;
  onMessageSquad: (target: SquadMessageTarget) => void;
}) {
  const messageable = canChat && group.team_id != null && group.squad_id != null;
  const label =
    group.squad_id != null
      ? `Команда ${teamLabel(group.team_id)} · Отряд ${squadLabel(group.squad_id)}`
      : `Команда ${teamLabel(group.team_id)} · Без отряда`;
  const colSpan = (canBan ? 7 : 6) + (canBulk ? 1 : 0);
  const groupSelectable = group.players
    .map((player) => player.player_id)
    .filter((id): id is string => id !== null);
  const groupSelected =
    groupSelectable.length > 0 && groupSelectable.every((id) => selected.has(id));

  return (
    <>
      <tr className="border-t border-neutral-800 bg-neutral-900/60">
        <th
          colSpan={colSpan}
          className="py-1 pr-3 text-left text-[10px] font-medium text-neutral-400"
        >
          <div className="flex items-center justify-between">
            <span className="flex items-center gap-2">
              {canBulk && groupSelectable.length > 0 ? (
                <input
                  type="checkbox"
                  aria-label={`Выделить отряд: ${label}`}
                  checked={groupSelected}
                  onChange={() =>
                    onSelectGroup((current) => {
                      const next = new Set(current);
                      for (const id of groupSelectable) {
                        if (groupSelected) next.delete(id);
                        else next.add(id);
                      }
                      return next;
                    })
                  }
                  className="accent-red-600"
                />
              ) : null}
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
        <RosterRow
          key={player.eos_id}
          player={player}
          now={now}
          serverId={serverId}
          canChat={canChat}
          canBan={canBan}
          canBulk={canBulk}
          checked={player.player_id !== null && selected.has(player.player_id)}
          onToggleSelected={onToggleSelected}
        />
      ))}
    </>
  );
}

function RosterRow({
  player,
  now,
  serverId,
  canChat,
  canBan,
  canBulk,
  checked,
  onToggleSelected,
}: {
  player: RosterPlayer;
  now: number;
  serverId: string;
  canChat: boolean;
  canBan: boolean;
  canBulk: boolean;
  checked: boolean;
  onToggleSelected: (playerId: string) => void;
}) {
  return (
    <tr className="border-t border-neutral-900 hover:bg-neutral-900/40">
      {canBulk ? (
        <td className="py-1.5 pr-2">
          <input
            type="checkbox"
            aria-label={`Выбрать игрока: ${player.name}`}
            checked={checked}
            disabled={player.player_id === null}
            title={
              player.player_id === null ? 'Игрок ещё не сопоставлен с профилем панели' : undefined
            }
            onChange={() => player.player_id && onToggleSelected(player.player_id)}
            className="accent-red-600 disabled:opacity-30"
          />
        </td>
      ) : null}
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
          <DirectMessageButton
            playerId={player.player_id}
            name={player.name}
            canChat={canChat}
            serverId={serverId}
            className="rounded px-1 text-[10px] text-sky-400 hover:bg-neutral-800"
          />
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
