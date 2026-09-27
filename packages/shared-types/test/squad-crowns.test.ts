import { describe, expect, it } from 'vitest';
import { SQUAD_CROWNS_TTL_SECONDS, squadCrownSchema, squadCrownsKey } from '../src/squad-crowns.js';

const squad = {
  squad_name: 'Alpha',
  team_id: 1,
  squad_id: 3,
  created_at: '2026-09-27T21:04:00.000Z',
  handoffs: [{ to_name: 'Ivan', reason: 'passed', at: '2026-09-27T21:10:00.000Z' }],
  disbanded_at: null,
  abandoned_at: null,
};
const crown = { color: 'grey', squads: [squad] };

describe('squad crowns contract', () => {
  it('keys the hash per server', () => {
    expect(squadCrownsKey('srv-1')).toBe('rcon:squad-crowns:srv-1');
  });

  it('keeps crowns for six hours', () => {
    expect(SQUAD_CROWNS_TTL_SECONDS).toBe(21_600);
  });

  it('accepts a grey and a red crown', () => {
    expect(squadCrownSchema.safeParse(crown).success).toBe(true);
    expect(squadCrownSchema.safeParse({ ...crown, color: 'red' }).success).toBe(true);
  });

  it('accepts a squad whose creation the worker never saw', () => {
    expect(
      squadCrownSchema.safeParse({ ...crown, squads: [{ ...squad, created_at: null }] }).success,
    ).toBe(true);
  });

  it('rejects an unknown colour, a bad timestamp and extra keys', () => {
    expect(squadCrownSchema.safeParse({ ...crown, color: 'gold' }).success).toBe(false);
    expect(
      squadCrownSchema.safeParse({ ...crown, squads: [{ ...squad, created_at: '21:04' }] }).success,
    ).toBe(false);
    expect(squadCrownSchema.safeParse({ ...crown, extra: true }).success).toBe(false);
  });
});
