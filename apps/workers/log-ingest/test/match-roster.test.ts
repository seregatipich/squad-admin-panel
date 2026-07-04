import { describe, expect, it } from 'vitest';
import {
  assembleMatchRoster,
  DEFAULT_JOIN_GRACE_SECONDS,
  filterRosterByPlaySeconds,
  type MatchRosterEntry,
  type SessionInterval,
  type TeamSquad,
} from '../src/match-roster/store.js';

const T0 = new Date('2026-07-05T18:00:00.000Z');
const MATCH_END = new Date(T0.getTime() + 3600_000);

const at = (offsetSeconds: number) => new Date(T0.getTime() + offsetSeconds * 1000);

const PLAYER_A = '11111111-1111-1111-1111-111111111111';
const PLAYER_B = '22222222-2222-2222-2222-222222222222';
const PLAYER_C = '33333333-3333-3333-3333-333333333333';
const PLAYER_D = '44444444-4444-4444-4444-444444444444';
const PLAYER_E = '55555555-5555-5555-5555-555555555555';

function byId(entries: MatchRosterEntry[]): Map<string, MatchRosterEntry> {
  return new Map(entries.map((entry) => [entry.playerId, entry]));
}

describe('assembleMatchRoster', () => {
  const sessions: SessionInterval[] = [
    { playerId: PLAYER_A, connectedAt: at(-100), disconnectedAt: at(1800) },
    { playerId: PLAYER_B, connectedAt: at(0), disconnectedAt: at(600) },
    { playerId: PLAYER_B, connectedAt: at(900), disconnectedAt: null },
    { playerId: PLAYER_C, connectedAt: at(100), disconnectedAt: at(3500) },
    { playerId: PLAYER_D, connectedAt: at(-500), disconnectedAt: at(-100) },
    { playerId: PLAYER_E, connectedAt: at(3570), disconnectedAt: null },
  ];
  const teamSquadByPlayer = new Map<string, TeamSquad>([
    [PLAYER_A, { team: 1, squadName: '2' }],
    [PLAYER_B, { team: 2, squadName: null }],
  ]);

  const roster = assembleMatchRoster({
    matchStart: T0,
    matchEnd: MATCH_END,
    sessions,
    teamSquadByPlayer,
  });
  const entries = byId(roster);

  it('excludes players whose sessions never intersect the match interval', () => {
    expect(roster).toHaveLength(4);
    expect(entries.has(PLAYER_D)).toBe(false);
  });

  it('clamps a pre-match join to the match start and computes play_seconds', () => {
    const a = entries.get(PLAYER_A);
    expect(a?.joinedAt.toISOString()).toBe(T0.toISOString());
    expect(a?.playSeconds).toBe(1800);
    expect(a?.leftAt?.toISOString()).toBe(at(1800).toISOString());
    expect(a?.team).toBe(1);
    expect(a?.squadName).toBe('2');
  });

  it('collapses a reconnect into one row with summed play_seconds', () => {
    const b = entries.get(PLAYER_B);
    expect(b).toBeDefined();
    expect(b?.playSeconds).toBe(3300);
    expect(b?.leftAt).toBeNull();
    expect(b?.joinedAt.toISOString()).toBe(T0.toISOString());
    expect(b?.team).toBe(2);
    expect(b?.squadName).toBeNull();
  });

  it('leaves team/squad null when no poll snapshot resolves the player', () => {
    const c = entries.get(PLAYER_C);
    expect(c?.playSeconds).toBe(3400);
    expect(c?.leftAt?.toISOString()).toBe(at(3500).toISOString());
    expect(c?.team).toBeNull();
    expect(c?.squadName).toBeNull();
  });

  it('keeps a last-seconds joiner present at close with left_at null', () => {
    const e = entries.get(PLAYER_E);
    expect(e?.playSeconds).toBe(30);
    expect(e?.leftAt).toBeNull();
  });

  it('returns an empty roster when the match interval is degenerate', () => {
    expect(assembleMatchRoster({ matchStart: MATCH_END, matchEnd: T0, sessions })).toEqual([]);
  });
});

describe('filterRosterByPlaySeconds', () => {
  const roster = assembleMatchRoster({
    matchStart: T0,
    matchEnd: MATCH_END,
    sessions: [
      { playerId: PLAYER_A, connectedAt: at(0), disconnectedAt: at(3600) },
      { playerId: PLAYER_E, connectedAt: at(3570), disconnectedAt: null },
    ],
  });

  it('drops sub-threshold joiners at read time while write keeps them', () => {
    expect(roster.map((entry) => entry.playerId)).toContain(PLAYER_E);
    const filtered = filterRosterByPlaySeconds(roster, DEFAULT_JOIN_GRACE_SECONDS);
    expect(filtered.map((entry) => entry.playerId)).toEqual([PLAYER_A]);
  });
});
