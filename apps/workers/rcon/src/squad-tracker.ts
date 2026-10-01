/**
 * Squad history from consecutive roster snapshots (see
 * docs/components/workers/rcon/flows.md).
 *
 * RCON reports only squad creation (`squad-broadcast.ts`). Leader changes and
 * disbands are inferred by diffing the `ListSquads` + `ListPlayers` rows of two
 * roster refreshes, so a change faster than one refresh (A → B → C) is seen as
 * A → C. Within a match a squad is `(team_id, squad_id, creator EOS id)`:
 * Squad reuses squad numbers, and a new creator on an old number is a new squad.
 *
 * Pure: `PerServerSupervisor.trackSquads` owns the state between calls, the
 * match-boundary resets, persistence and crowns.
 */
import type {
  SquadCreatedPayload,
  SquadDisbandedPayload,
  SquadLeaderChangedPayload,
  SquadLeaderChangeReason,
  SquadPlayerRef,
} from '@squad/shared-types';
import type { RconPlayer } from './parse-list-players.js';
import type { RconSquad } from './parse-list-squads.js';
import type { SquadCreatedBroadcast } from './squad-broadcast.js';

/**
 * When every squad of a snapshot holding at least this many vanishes in one
 * refresh, the map changed: the tracker resets instead of reporting disbands.
 */
export const MASS_VANISH_MIN_SQUADS = 3;

export interface TrackedSquad {
  teamId: number;
  teamName: string;
  squadId: number;
  name: string;
  creator: SquadPlayerRef;
  /** The player `ListPlayers` flags `Is Leader: True` in this squad, if any. */
  leader: SquadPlayerRef | null;
  /** The most recent non-null leader; bridges a refresh that caught the squad leaderless. */
  lastLeader: SquadPlayerRef | null;
}

export interface PlayerPlacement {
  teamId: number | null;
  squadId: number | null;
}

export interface SquadSnapshot {
  polledAt: string;
  /** Keyed by {@link squadKey}. */
  squads: Map<string, TrackedSquad>;
  /** Every online player by EOS id; used to explain why a leader changed. */
  players: Map<string, PlayerPlacement>;
}

export type SquadEvent =
  | { type: 'squad.created'; at: string; payload: SquadCreatedPayload }
  | { type: 'squad.leader_changed'; at: string; payload: SquadLeaderChangedPayload }
  | { type: 'squad.disbanded'; at: string; payload: SquadDisbandedPayload };

export interface SquadDiff {
  events: SquadEvent[];
  /** The snapshot to pass as `prev` next time. */
  state: SquadSnapshot;
  /** Creation broadcasts no new squad has claimed yet. */
  pending: SquadCreatedBroadcast[];
  /** True when a map change was detected; the caller clears the match's crowns. */
  reset: boolean;
}

/** Identity of a squad within a match. */
export function squadKey(teamId: number, squadId: number, creatorEosId: string): string {
  return `${teamId}:${squadId}:${creatorEosId}`;
}

function playerRef(player: RconPlayer): SquadPlayerRef {
  return { eos_id: player.eos_id, steam_id64: player.steam_id64, name: player.name };
}

/**
 * Builds one refresh's snapshot. A squad whose creator has no EOS id is not
 * tracked, because history and crowns are keyed by EOS id. The leader is the
 * player flagged `Is Leader` with the squad's own team and squad number.
 */
export function buildSquadSnapshot(
  squads: RconSquad[],
  players: RconPlayer[],
  polledAt: string,
): SquadSnapshot {
  const placements = new Map<string, PlayerPlacement>();
  const online = new Map<string, RconPlayer>();
  const leaders = new Map<string, SquadPlayerRef>();
  for (const player of players) {
    placements.set(player.eos_id, { teamId: player.team_id, squadId: player.squad_id });
    online.set(player.eos_id, player);
    if (player.is_leader && player.team_id !== null && player.squad_id !== null) {
      leaders.set(`${player.team_id}:${player.squad_id}`, playerRef(player));
    }
  }

  const tracked = new Map<string, TrackedSquad>();
  for (const squad of squads) {
    const creatorEosId = squad.creator_eos_id;
    if (!creatorEosId) continue;
    const leader = leaders.get(`${squad.team_id}:${squad.squad_id}`) ?? null;
    tracked.set(squadKey(squad.team_id, squad.squad_id, creatorEosId), {
      teamId: squad.team_id,
      teamName: squad.team_name,
      squadId: squad.squad_id,
      name: squad.name,
      creator: {
        eos_id: creatorEosId,
        steam_id64: squad.creator_steam_id64 ?? online.get(creatorEosId)?.steam_id64 ?? null,
        name: squad.creator_name,
      },
      leader,
      lastLeader: leader,
    });
  }
  return { polledAt, squads: tracked, players: placements };
}

function payloadBase(squad: TrackedSquad): SquadCreatedPayload {
  return {
    team_id: squad.teamId,
    team_name: squad.teamName,
    squad_id: squad.squadId,
    squad_name: squad.name,
    creator: squad.creator,
  };
}

function leaveReason(
  from: SquadPlayerRef,
  squad: TrackedSquad,
  next: SquadSnapshot,
): SquadLeaderChangeReason {
  const placement = next.players.get(from.eos_id);
  if (!placement) return 'disconnected';
  const stillHere = placement.teamId === squad.teamId && placement.squadId === squad.squadId;
  return stillHere ? 'passed' : 'left_squad';
}

/**
 * Compares two consecutive snapshots.
 *
 * - `prev === null` (worker start, RCON reconnect, match reset) is a baseline:
 *   `next` is stored and nothing is reported.
 * - Every squad of a `prev` holding {@link MASS_VANISH_MIN_SQUADS}+ squads gone
 *   at once is a map change: baseline, `reset: true`, pending broadcasts dropped.
 * - A new identity is `squad.created`, dated by the earliest matching broadcast
 *   (same squad number and creator EOS id). Every matching broadcast is
 *   consumed, so duplicates never date a later squad.
 * - A different non-null leader on the same identity is `squad.leader_changed`
 *   from the previous leader, or from `lastLeader` across a leaderless refresh.
 * - A vanished identity is `squad.disbanded`.
 *
 * Events come out as creations and leader changes in `next` order, then disbands.
 */
export function diffSquads(
  prev: SquadSnapshot | null,
  next: SquadSnapshot,
  pendingCreated: SquadCreatedBroadcast[],
): SquadDiff {
  if (prev === null) {
    return { events: [], state: next, pending: pendingCreated, reset: false };
  }
  const everySquadVanished = [...prev.squads.keys()].every((key) => !next.squads.has(key));
  if (prev.squads.size >= MASS_VANISH_MIN_SQUADS && everySquadVanished) {
    return { events: [], state: next, pending: [], reset: true };
  }

  const events: SquadEvent[] = [];
  let pending = pendingCreated;
  const squads = new Map<string, TrackedSquad>();

  for (const [key, squad] of next.squads) {
    const before = prev.squads.get(key);
    if (!before) {
      const matching = pending.filter(
        (broadcast) =>
          broadcast.squadId === squad.squadId && broadcast.creatorEosId === squad.creator.eos_id,
      );
      pending = pending.filter((broadcast) => !matching.includes(broadcast));
      const earliest = matching.reduce<SquadCreatedBroadcast | undefined>(
        (first, broadcast) => (!first || broadcast.at < first.at ? broadcast : first),
        undefined,
      );
      const created: TrackedSquad = {
        ...squad,
        creator: {
          ...squad.creator,
          steam_id64: squad.creator.steam_id64 ?? earliest?.creatorSteamId64 ?? null,
        },
      };
      squads.set(key, created);
      events.push({
        type: 'squad.created',
        at: earliest?.at ?? next.polledAt,
        payload: payloadBase(created),
      });
      continue;
    }

    const previousLeader = before.leader ?? before.lastLeader;
    squads.set(key, { ...squad, lastLeader: squad.leader ?? previousLeader });
    if (!squad.leader || !previousLeader || squad.leader.eos_id === previousLeader.eos_id) continue;
    events.push({
      type: 'squad.leader_changed',
      at: next.polledAt,
      payload: {
        ...payloadBase(squad),
        from: previousLeader,
        to: squad.leader,
        reason: leaveReason(previousLeader, squad, next),
      },
    });
  }

  for (const [key, squad] of prev.squads) {
    if (next.squads.has(key)) continue;
    const lastLeader = squad.leader ?? squad.lastLeader;
    events.push({
      type: 'squad.disbanded',
      at: next.polledAt,
      payload: {
        ...payloadBase(squad),
        last_leader: lastLeader,
        creator_was_leader: lastLeader !== null && lastLeader.eos_id === squad.creator.eos_id,
      },
    });
  }

  return { events, state: { ...next, squads }, pending, reset: false };
}
