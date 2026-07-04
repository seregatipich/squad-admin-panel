import { describe, expect, it } from 'vitest';
import type { RconPlayer } from '../src/parse-list-players.js';
import { buildRoster } from '../src/roster.js';

function makePlayer(overrides?: Partial<RconPlayer>): RconPlayer {
  return {
    rcon_id: 0,
    eos_id: 'abcdef0123456789abcdef0123456789',
    steam_id64: '76561198012345678',
    name: 'Alpha',
    team_id: 1,
    squad_id: 2,
    is_leader: true,
    role: 'USA_Rifleman_01',
    ...overrides,
  };
}

describe('buildRoster', () => {
  it('stamps first_seen_at with polledAt for newly-seen players', () => {
    const polledAt = '2026-07-05T10:00:00.000Z';
    const { entries, firstSeen } = buildRoster([makePlayer()], new Map(), polledAt);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.first_seen_at).toBe(polledAt);
    expect(firstSeen.get('abcdef0123456789abcdef0123456789')).toBe(polledAt);
  });

  it('preserves the original first_seen_at across polls', () => {
    const firstPoll = '2026-07-05T10:00:00.000Z';
    const secondPoll = '2026-07-05T10:00:30.000Z';
    const first = buildRoster([makePlayer()], new Map(), firstPoll);
    const second = buildRoster([makePlayer()], first.firstSeen, secondPoll);
    expect(second.entries[0]?.first_seen_at).toBe(firstPoll);
  });

  it('drops departed players from the first-seen map', () => {
    const firstPoll = '2026-07-05T10:00:00.000Z';
    const secondPoll = '2026-07-05T10:00:30.000Z';
    const alpha = makePlayer({ eos_id: 'aaaa456789abcdef0123456789abcdef' });
    const bravo = makePlayer({ eos_id: 'bbbb456789abcdef0123456789abcdef', name: 'Bravo' });
    const first = buildRoster([alpha, bravo], new Map(), firstPoll);
    const second = buildRoster([alpha], first.firstSeen, secondPoll);
    expect(second.firstSeen.has('bbbb456789abcdef0123456789abcdef')).toBe(false);
    expect(second.firstSeen.get('aaaa456789abcdef0123456789abcdef')).toBe(firstPoll);
  });

  it('carries EOS-only players with null steam into the roster', () => {
    const polledAt = '2026-07-05T10:00:00.000Z';
    const eosOnly = makePlayer({ steam_id64: null, name: 'EpicOnly' });
    const { entries } = buildRoster([eosOnly], new Map(), polledAt);
    expect(entries[0]?.steam_id64).toBeNull();
    expect(entries[0]?.name).toBe('EpicOnly');
  });

  it('coerces a null is_leader to false', () => {
    const polledAt = '2026-07-05T10:00:00.000Z';
    const { entries } = buildRoster([makePlayer({ is_leader: null })], new Map(), polledAt);
    expect(entries[0]?.is_leader).toBe(false);
  });
});
