import { describe, expect, it } from 'vitest';
import { aggregateCombatStats, type CombatEventRow } from '../src/match-roster/combat.js';

const ALICE = '11111111-1111-1111-1111-111111111111';
const BOB = '22222222-2222-2222-2222-222222222222';
const CAROL = '33333333-3333-3333-3333-333333333333';
const MEDIC = '44444444-4444-4444-4444-444444444444';

function death(
  attacker: string | null,
  victim: string | null,
  extra: { isTeamkill?: boolean; isSuicide?: boolean } = {},
): CombatEventRow {
  return {
    kind: 'combat_death',
    payload: {
      attacker_player_id: attacker,
      victim_player_id: victim,
      is_teamkill: extra.isTeamkill ?? false,
      is_suicide: extra.isSuicide ?? false,
    },
  };
}

function wound(
  attacker: string | null,
  victim: string | null,
  extra: { isTeamkill?: boolean; isSuicide?: boolean } = {},
): CombatEventRow {
  return {
    kind: 'combat_wound',
    payload: {
      attacker_player_id: attacker,
      victim_player_id: victim,
      is_teamkill: extra.isTeamkill ?? false,
      is_suicide: extra.isSuicide ?? false,
    },
  };
}

function revive(medic: string | null, revived: string | null): CombatEventRow {
  return {
    kind: 'combat_revive',
    payload: { medic_player_id: medic, revived_player_id: revived },
  };
}

describe('aggregateCombatStats', () => {
  it('reports no combat data for an empty interval', () => {
    const stats = aggregateCombatStats([]);
    expect(stats.present).toBe(false);
    expect(stats.byPlayer.size).toBe(0);
  });

  it('credits the attacker a kill and the victim a death on a normal death', () => {
    const stats = aggregateCombatStats([death(ALICE, BOB)]);
    expect(stats.present).toBe(true);
    expect(stats.byPlayer.get(ALICE)).toMatchObject({ kills: 1, deaths: 0, teamkills: 0 });
    expect(stats.byPlayer.get(BOB)).toMatchObject({ kills: 0, deaths: 1 });
  });

  it('counts a teamkill in teamkills and never in kills, while the victim still dies', () => {
    const stats = aggregateCombatStats([death(ALICE, BOB, { isTeamkill: true })]);
    expect(stats.byPlayer.get(ALICE)).toMatchObject({ kills: 0, teamkills: 1 });
    expect(stats.byPlayer.get(BOB)).toMatchObject({ deaths: 1 });
  });

  it('records a suicide as a death without a kill', () => {
    const stats = aggregateCombatStats([death(ALICE, ALICE, { isSuicide: true })]);
    expect(stats.byPlayer.get(ALICE)).toMatchObject({ kills: 0, deaths: 1, teamkills: 0 });
  });

  it('counts inflicted wounds for the attacker but excludes teamkill and self wounds', () => {
    const stats = aggregateCombatStats([
      wound(ALICE, BOB),
      wound(ALICE, CAROL),
      wound(ALICE, BOB, { isTeamkill: true }),
      wound(ALICE, ALICE, { isSuicide: true }),
    ]);
    expect(stats.byPlayer.get(ALICE)).toMatchObject({ wounds: 2 });
  });

  it('credits revives to the medic', () => {
    const stats = aggregateCombatStats([revive(MEDIC, BOB), revive(MEDIC, CAROL)]);
    expect(stats.byPlayer.get(MEDIC)).toMatchObject({ revives: 2 });
  });

  it('ignores combat_damage rows for counters but treats them as presence', () => {
    const stats = aggregateCombatStats([
      { kind: 'combat_damage', payload: { attacker_player_id: ALICE, victim_player_id: BOB } },
    ]);
    expect(stats.present).toBe(true);
    expect(stats.byPlayer.size).toBe(0);
  });

  it('skips events with no resolved player id', () => {
    const stats = aggregateCombatStats([death(null, null), wound(null, BOB), revive(null, BOB)]);
    expect(stats.present).toBe(true);
    expect(stats.byPlayer.size).toBe(0);
  });

  it('accumulates a full fixture round into per-player totals', () => {
    const stats = aggregateCombatStats([
      death(ALICE, BOB),
      death(ALICE, CAROL),
      death(BOB, ALICE),
      death(ALICE, BOB, { isTeamkill: true }),
      wound(ALICE, CAROL),
      wound(BOB, ALICE),
      revive(MEDIC, ALICE),
      revive(MEDIC, BOB),
    ]);

    expect(stats.byPlayer.get(ALICE)).toEqual({
      kills: 2,
      deaths: 1,
      teamkills: 1,
      wounds: 1,
      revives: 0,
    });
    expect(stats.byPlayer.get(BOB)).toEqual({
      kills: 1,
      deaths: 2,
      teamkills: 0,
      wounds: 1,
      revives: 0,
    });
    expect(stats.byPlayer.get(CAROL)).toEqual({
      kills: 0,
      deaths: 1,
      teamkills: 0,
      wounds: 0,
      revives: 0,
    });
    expect(stats.byPlayer.get(MEDIC)).toEqual({
      kills: 0,
      deaths: 0,
      teamkills: 0,
      wounds: 0,
      revives: 2,
    });
  });
});
