import { describe, expect, it } from 'vitest';
import { computeSeedingTick, isSeedLayer, type SeedingState } from '../src/seeding.js';

const LIVE_AT = 60;
const HYSTERESIS = 5;

function liveState(overrides: Partial<SeedingState> = {}): SeedingState {
  return {
    state: 'live',
    started_at: null,
    current_players: 80,
    live_at: LIVE_AT,
    progress_pct: 100,
    layer: 'Yehorivka RAAS v11',
    updated_at: '2026-07-14T10:00:00.000Z',
    ...overrides,
  };
}

describe('isSeedLayer', () => {
  it('catalog isSeed=true wins regardless of name', () => {
    expect(isSeedLayer('Yehorivka RAAS v11', true)).toBe(true);
  });

  it('catalog isSeed=false overrides a name that would otherwise match /seed/i', () => {
    expect(isSeedLayer('Sumari Seed v1', false)).toBe(false);
  });

  it('falls back to /seed/i on the layer name when the catalog has no entry (null)', () => {
    expect(isSeedLayer('Sumari Seed v1', null)).toBe(true);
    expect(isSeedLayer('Yehorivka RAAS v11', null)).toBe(false);
  });

  it('returns false for a null layer name with no catalog entry', () => {
    expect(isSeedLayer(null, null)).toBe(false);
  });
});

describe('computeSeedingTick: live -> seeding', () => {
  it('enters seeding once player count drops below liveAt - hysteresis', () => {
    const prev = liveState({ current_players: 80 });
    const result = computeSeedingTick(prev, {
      playerCount: 54, // < 60 - 5
      seedLayer: false,
      liveAt: LIVE_AT,
      hysteresis: HYSTERESIS,
      now: '2026-07-14T10:01:00.000Z',
      layer: 'Yehorivka RAAS v11',
    });
    expect(result.transition).toBe('started');
    expect(result.state.state).toBe('seeding');
    expect(result.state.started_at).toBe('2026-07-14T10:01:00.000Z');
  });

  it('does NOT transition while inside the hysteresis band [liveAt - hysteresis, liveAt)', () => {
    const prev = liveState({ current_players: 80 });
    const result = computeSeedingTick(prev, {
      playerCount: 58, // inside [55, 60)
      seedLayer: false,
      liveAt: LIVE_AT,
      hysteresis: HYSTERESIS,
      now: '2026-07-14T10:01:00.000Z',
      layer: 'Yehorivka RAAS v11',
    });
    expect(result.transition).toBeNull();
    expect(result.state.state).toBe('live');
  });

  it('enters seeding when the current layer is a seed layer even above liveAt', () => {
    const prev = liveState({ current_players: 100 });
    const result = computeSeedingTick(prev, {
      playerCount: 100,
      seedLayer: true,
      liveAt: LIVE_AT,
      hysteresis: HYSTERESIS,
      now: '2026-07-14T10:01:00.000Z',
      layer: 'Sumari Seed v1',
    });
    expect(result.transition).toBe('started');
    expect(result.state.state).toBe('seeding');
  });
});

describe('computeSeedingTick: seeding -> live', () => {
  const seedingState = (overrides: Partial<SeedingState> = {}): SeedingState => ({
    state: 'seeding',
    started_at: '2026-07-14T09:00:00.000Z',
    current_players: 40,
    live_at: LIVE_AT,
    progress_pct: 66,
    layer: 'Yehorivka RAAS v11',
    updated_at: '2026-07-14T09:00:00.000Z',
    ...overrides,
  });

  it('exits to live only once player count reaches liveAt AND layer is not a seed layer', () => {
    const result = computeSeedingTick(seedingState(), {
      playerCount: 60,
      seedLayer: false,
      liveAt: LIVE_AT,
      hysteresis: HYSTERESIS,
      now: '2026-07-14T10:05:00.000Z',
      layer: 'Yehorivka RAAS v11',
    });
    expect(result.transition).toBe('ended');
    expect(result.state.state).toBe('live');
    expect(result.state.started_at).toBeNull();
  });

  it('stays in seeding at liveAt-1 (one below threshold)', () => {
    const result = computeSeedingTick(seedingState(), {
      playerCount: 59,
      seedLayer: false,
      liveAt: LIVE_AT,
      hysteresis: HYSTERESIS,
      now: '2026-07-14T10:05:00.000Z',
      layer: 'Yehorivka RAAS v11',
    });
    expect(result.transition).toBeNull();
    expect(result.state.state).toBe('seeding');
  });

  it('stays in seeding at full population if the layer is still a seed layer', () => {
    const result = computeSeedingTick(seedingState({ current_players: 99 }), {
      playerCount: 100,
      seedLayer: true,
      liveAt: LIVE_AT,
      hysteresis: HYSTERESIS,
      now: '2026-07-14T10:05:00.000Z',
      layer: 'Sumari Seed v1',
    });
    expect(result.transition).toBeNull();
    expect(result.state.state).toBe('seeding');
  });

  it('preserves started_at across seeding polls that do not transition', () => {
    const result = computeSeedingTick(seedingState({ started_at: '2026-07-14T09:00:00.000Z' }), {
      playerCount: 45,
      seedLayer: false,
      liveAt: LIVE_AT,
      hysteresis: HYSTERESIS,
      now: '2026-07-14T09:30:00.000Z',
      layer: 'Yehorivka RAAS v11',
    });
    expect(result.transition).toBeNull();
    expect(result.state.started_at).toBe('2026-07-14T09:00:00.000Z');
  });
});

describe('computeSeedingTick: initial state (prev = null)', () => {
  it('derives a live initial state without emitting a transition', () => {
    const result = computeSeedingTick(null, {
      playerCount: 80,
      seedLayer: false,
      liveAt: LIVE_AT,
      hysteresis: HYSTERESIS,
      now: '2026-07-14T08:00:00.000Z',
      layer: 'Yehorivka RAAS v11',
    });
    expect(result.transition).toBeNull();
    expect(result.state.state).toBe('live');
    expect(result.state.started_at).toBeNull();
  });

  it('emits a started transition when the initial evaluation is already seeding', () => {
    const result = computeSeedingTick(null, {
      playerCount: 10,
      seedLayer: false,
      liveAt: LIVE_AT,
      hysteresis: HYSTERESIS,
      now: '2026-07-14T08:00:00.000Z',
      layer: 'Yehorivka RAAS v11',
    });
    expect(result.transition).toBe('started');
    expect(result.state.state).toBe('seeding');
    expect(result.state.started_at).toBe('2026-07-14T08:00:00.000Z');
  });
});

describe('computeSeedingTick: progress_pct', () => {
  it('is floor(count/liveAt*100)', () => {
    const result = computeSeedingTick(null, {
      playerCount: 30,
      seedLayer: false,
      liveAt: LIVE_AT,
      hysteresis: HYSTERESIS,
      now: '2026-07-14T08:00:00.000Z',
      layer: null,
    });
    expect(result.state.progress_pct).toBe(50);
  });

  it('clamps to 100 once player count exceeds liveAt', () => {
    const result = computeSeedingTick(null, {
      playerCount: 150,
      seedLayer: false,
      liveAt: LIVE_AT,
      hysteresis: HYSTERESIS,
      now: '2026-07-14T08:00:00.000Z',
      layer: null,
    });
    expect(result.state.progress_pct).toBe(100);
  });
});

describe('computeSeedingTick: full crossing sequence (acceptance criterion 1)', () => {
  it('yields exactly one started + one ended over a 80 -> 40 -> 70 poll sequence', () => {
    const pollCounts = [80, 70, 62, 58, 54, 40, 45, 55, 60, 65, 70];
    let state: SeedingState | null = liveState({ current_players: 80 });
    const transitions: Array<'started' | 'ended'> = [];
    let ts = 0;
    for (const playerCount of pollCounts) {
      ts += 1;
      const result = computeSeedingTick(state, {
        playerCount,
        seedLayer: false,
        liveAt: LIVE_AT,
        hysteresis: HYSTERESIS,
        now: `2026-07-14T10:${String(ts).padStart(2, '0')}:00.000Z`,
        layer: 'Yehorivka RAAS v11',
      });
      state = result.state;
      if (result.transition) transitions.push(result.transition);
    }
    expect(transitions).toEqual(['started', 'ended']);
  });
});
