import type { SquadPlayerRef } from '@squad/shared-types';
import { describe, expect, it } from 'vitest';
import type { RconPlayer } from '../src/parse-list-players.js';
import type { RconSquad } from '../src/parse-list-squads.js';
import type { SquadCreatedBroadcast } from '../src/squad-broadcast.js';
import { buildSquadSnapshot, diffSquads, type SquadSnapshot } from '../src/squad-tracker.js';

const T0 = '2026-09-27T21:00:00.000Z';
const T1 = '2026-09-27T21:00:02.000Z';
const T2 = '2026-09-27T21:00:04.000Z';
const NAMES = ['', 'Anna', 'Boris', 'Clara', 'Dmitri', 'Egor'];

const eos = (n: number) => n.toString(16).padStart(32, '0');
const steam = (n: number) => `765611980000000${String(n).padStart(2, '0')}`;
const ref = (n: number): SquadPlayerRef => ({
  eos_id: eos(n),
  steam_id64: steam(n),
  name: NAMES[n] ?? '',
});
const ANNA = ref(1);
const BORIS = ref(2);
const CLARA = ref(3);
const ALPHA_BASE = {
  team_id: 1,
  team_name: 'United States Army',
  squad_id: 1,
  squad_name: 'Alpha',
  creator: ANNA,
};

function player(n: number, squadId: number | null, leader = false, teamId = 1): RconPlayer {
  return {
    rcon_id: n,
    eos_id: eos(n),
    steam_id64: steam(n),
    name: NAMES[n] ?? '',
    team_id: teamId,
    squad_id: squadId,
    is_leader: leader,
    role: 'USA_Rifleman_01',
  };
}

function squad(squadId: number, creator: number, name = 'Alpha', teamId = 1): RconSquad {
  return {
    team_id: teamId,
    team_name: teamId === 1 ? 'United States Army' : 'Russian Ground Forces',
    squad_id: squadId,
    name,
    size: 2,
    locked: false,
    creator_name: NAMES[creator] ?? '',
    creator_eos_id: eos(creator),
    creator_steam_id64: steam(creator),
    is_command_squad: false,
  };
}

function broadcast(squadId: number, creator: number, at: string): SquadCreatedBroadcast {
  return {
    creatorName: NAMES[creator] ?? '',
    creatorEosId: eos(creator),
    creatorSteamId64: steam(creator),
    squadId,
    squadName: 'Bravo',
    teamName: 'United States Army',
    at,
  };
}

/** Anna created and leads squad 1; Boris is in it. */
function annaLeads(at = T0): SquadSnapshot {
  return buildSquadSnapshot([squad(1, 1)], [player(1, 1, true), player(2, 1)], at);
}

describe('buildSquadSnapshot', () => {
  it('keys squads by team, number and creator and finds each leader', () => {
    const snap = annaLeads();
    expect(snap.squads.get(`1:1:${eos(1)}`)).toEqual({
      teamId: 1,
      teamName: 'United States Army',
      squadId: 1,
      name: 'Alpha',
      creator: ANNA,
      leader: ANNA,
      lastLeader: ANNA,
    });
    expect(snap.players.get(eos(2))).toEqual({ teamId: 1, squadId: 1 });
  });

  it('skips a squad whose creator has no EOS id', () => {
    expect(buildSquadSnapshot([{ ...squad(1, 1), creator_eos_id: null }], [], T0).squads.size).toBe(
      0,
    );
  });

  it('does not take the leader of the same squad number on the other team', () => {
    const snap = buildSquadSnapshot([squad(1, 1)], [player(1, 1), player(3, 1, true, 2)], T0);
    expect(snap.squads.get(`1:1:${eos(1)}`)?.leader).toBeNull();
  });
});

describe('diffSquads', () => {
  it('treats the first snapshot as a baseline', () => {
    const result = diffSquads(null, annaLeads(), []);
    expect(result.events).toEqual([]);
    expect(result.reset).toBe(false);
    expect(result.state.squads.size).toBe(1);
  });

  it('keeps unmatched broadcasts pending on a baseline', () => {
    const pending = [broadcast(2, 3, T0)];
    expect(diffSquads(null, annaLeads(), pending).pending).toEqual(pending);
  });

  it('reports a new squad at poll time when no broadcast arrived', () => {
    const next = buildSquadSnapshot(
      [squad(1, 1), squad(2, 3, 'Bravo')],
      [player(1, 1, true), player(2, 1), player(3, 2, true)],
      T1,
    );
    expect(diffSquads(annaLeads(), next, []).events).toEqual([
      {
        type: 'squad.created',
        at: T1,
        payload: { ...ALPHA_BASE, squad_id: 2, squad_name: 'Bravo', creator: CLARA },
      },
    ]);
  });

  it('dates a new squad by its earliest broadcast and consumes every duplicate', () => {
    const early = broadcast(2, 3, '2026-09-27T21:00:01.000Z');
    const late = broadcast(2, 3, '2026-09-27T21:00:01.500Z');
    const other = broadcast(5, 4, '2026-09-27T21:00:01.200Z');
    const next = buildSquadSnapshot(
      [squad(1, 1), squad(2, 3, 'Bravo')],
      [player(1, 1, true), player(2, 1), player(3, 2, true)],
      T1,
    );
    const result = diffSquads(annaLeads(), next, [late, other, early]);
    expect(result.events).toHaveLength(1);
    expect(result.events[0]?.at).toBe(early.at);
    expect(result.pending).toEqual([other]);
  });

  it('fills a missing creator Steam id from the broadcast', () => {
    const next = buildSquadSnapshot(
      [squad(1, 1), { ...squad(2, 3, 'Bravo'), creator_steam_id64: null }],
      [player(1, 1, true), player(2, 1), { ...player(3, 2, true), steam_id64: null }],
      T1,
    );
    const [created] = diffSquads(annaLeads(), next, [broadcast(2, 3, T0)]).events;
    expect(created?.payload.creator.steam_id64).toBe(steam(3));
  });

  it('reports a handoff to a squadmate as passed', () => {
    const next = buildSquadSnapshot([squad(1, 1)], [player(1, 1), player(2, 1, true)], T1);
    expect(diffSquads(annaLeads(), next, []).events).toEqual([
      {
        type: 'squad.leader_changed',
        at: T1,
        payload: { ...ALPHA_BASE, from: ANNA, to: BORIS, reason: 'passed' },
      },
    ]);
  });

  it('reports left_squad when the old leader moved to another squad', () => {
    const prev = buildSquadSnapshot(
      [squad(1, 1), squad(2, 3, 'Bravo')],
      [player(1, 1, true), player(2, 1), player(3, 2, true)],
      T0,
    );
    const next = buildSquadSnapshot(
      [squad(1, 1), squad(2, 3, 'Bravo')],
      [player(1, 2), player(2, 1, true), player(3, 2, true)],
      T1,
    );
    const change = diffSquads(prev, next, []).events.find((e) => e.type === 'squad.leader_changed');
    expect(change?.payload).toMatchObject({ reason: 'left_squad', from: ANNA, to: BORIS });
  });

  it('reports left_squad when the old leader is online without a squad', () => {
    const next = buildSquadSnapshot([squad(1, 1)], [player(1, null), player(2, 1, true)], T1);
    expect(diffSquads(annaLeads(), next, []).events[0]?.payload).toMatchObject({
      reason: 'left_squad',
    });
  });

  it('reports disconnected when the old leader is gone from ListPlayers', () => {
    const next = buildSquadSnapshot([squad(1, 1)], [player(2, 1, true)], T1);
    expect(diffSquads(annaLeads(), next, []).events[0]?.payload).toMatchObject({
      reason: 'disconnected',
    });
  });

  it('bridges a leaderless gap: A → nobody → B is one change from A', () => {
    const gap = diffSquads(
      annaLeads(),
      buildSquadSnapshot([squad(1, 1)], [player(1, null), player(2, 1)], T1),
      [],
    );
    expect(gap.events).toEqual([]);
    const after = diffSquads(
      gap.state,
      buildSquadSnapshot([squad(1, 1)], [player(1, null), player(2, 1, true)], T2),
      [],
    );
    expect(after.events).toHaveLength(1);
    expect(after.events[0]?.payload).toMatchObject({ from: ANNA, to: BORIS, reason: 'left_squad' });
  });

  it('reports nothing when the same leader reappears after a leaderless refresh', () => {
    const flicker = diffSquads(
      annaLeads(),
      buildSquadSnapshot([squad(1, 1)], [player(1, 1), player(2, 1)], T1),
      [],
    );
    const back = diffSquads(
      flicker.state,
      buildSquadSnapshot([squad(1, 1)], [player(1, 1, true), player(2, 1)], T2),
      [],
    );
    expect([...flicker.events, ...back.events]).toEqual([]);
  });

  it('reports a reused squad number with another creator as a creation and a disband', () => {
    const next = buildSquadSnapshot(
      [squad(1, 3, 'Bravo')],
      [player(1, null), player(2, null), player(3, 1, true)],
      T1,
    );
    const { events } = diffSquads(annaLeads(), next, []);
    expect(events.map((e) => e.type)).toEqual(['squad.created', 'squad.disbanded']);
    expect(events[0]?.payload.creator).toEqual(CLARA);
    expect(events[1]?.payload.creator).toEqual(ANNA);
  });

  it('reports a disband and whether the creator was still leading', () => {
    const own = diffSquads(
      annaLeads(),
      buildSquadSnapshot([], [player(1, null), player(2, null)], T1),
      [],
    );
    expect(own.events).toEqual([
      {
        type: 'squad.disbanded',
        at: T1,
        payload: { ...ALPHA_BASE, last_leader: ANNA, creator_was_leader: true },
      },
    ]);
    const handedOff = diffSquads(
      annaLeads(),
      buildSquadSnapshot([squad(1, 1)], [player(1, 1), player(2, 1, true)], T1),
      [],
    );
    const later = diffSquads(handedOff.state, buildSquadSnapshot([], [], T2), []);
    expect(later.events[0]?.payload).toMatchObject({
      last_leader: BORIS,
      creator_was_leader: false,
    });
  });

  it('treats every squad of a 3+ squad snapshot vanishing at once as a map change', () => {
    const three = buildSquadSnapshot(
      [squad(1, 1), squad(2, 3, 'Bravo'), squad(3, 4, 'Charlie')],
      [player(1, 1, true), player(3, 2, true), player(4, 3, true)],
      T0,
    );
    const result = diffSquads(
      three,
      buildSquadSnapshot([], [player(1, null), player(3, null), player(4, null)], T1),
      [broadcast(9, 5, T0)],
    );
    expect(result).toMatchObject({ events: [], reset: true, pending: [] });
    expect(result.state.squads.size).toBe(0);
  });

  it('still reports disbands when only two squads vanish', () => {
    const two = buildSquadSnapshot(
      [squad(1, 1), squad(2, 3, 'Bravo')],
      [player(1, 1, true), player(3, 2, true)],
      T0,
    );
    const result = diffSquads(two, buildSquadSnapshot([], [], T1), []);
    expect(result.reset).toBe(false);
    expect(result.events.map((e) => e.type)).toEqual(['squad.disbanded', 'squad.disbanded']);
  });
});
