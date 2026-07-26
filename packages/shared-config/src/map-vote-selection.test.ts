import { describe, expect, it } from 'vitest';
import { type MapVoteSelectionInput, selectNextLayer } from './map-vote-selection.js';

function candidate(
  layer: string,
  overrides: Partial<MapVoteSelectionInput['candidates'][number]> = {},
): MapVoteSelectionInput['candidates'][number] {
  return { layer, map: `${layer} Map`, weight: 1, enabled: true, deprecated: false, ...overrides };
}

function makeInput(overrides: Partial<MapVoteSelectionInput> = {}): MapVoteSelectionInput {
  return {
    candidates: [candidate('Alpha RAAS v1'), candidate('Bravo RAAS v1')],
    recentMatches: [],
    settings: { selection: 'weighted_random', layerCooldown: 3, mapCooldown: 2 },
    seed: 'fixed-seed',
    ...overrides,
  };
}

describe('selectNextLayer (weighted_random)', () => {
  it('respects weights under a fixed seed', () => {
    const input = makeInput({
      candidates: [
        candidate('Alpha RAAS v1', { weight: 1 }),
        candidate('Bravo RAAS v1', { weight: 99 }),
      ],
    });

    const result = selectNextLayer(input);
    expect(result.eligible).toEqual([
      { layer: 'Alpha RAAS v1', weight: 1, probability: 0.01 },
      { layer: 'Bravo RAAS v1', weight: 99, probability: 0.99 },
    ]);

    let bravo = 0;
    for (let i = 0; i < 500; i++) {
      const { pick } = selectNextLayer({ ...input, seed: `seed-${i}` });
      if (pick === 'Bravo RAAS v1') bravo++;
    }
    expect(bravo).toBeGreaterThan(400);
  });

  it('is deterministic for the same seed', () => {
    const input = makeInput({
      candidates: [
        candidate('Alpha RAAS v1', { weight: 10 }),
        candidate('Bravo RAAS v1', { weight: 10 }),
        candidate('Charlie AAS v2', { weight: 10 }),
      ],
    });
    const first = selectNextLayer(input);
    const second = selectNextLayer(input);
    expect(first.pick).not.toBeNull();
    expect(second).toEqual(first);
  });

  it('excludes layers within layer cooldown', () => {
    const result = selectNextLayer(
      makeInput({
        recentMatches: [
          { layer: 'Alpha RAAS v1', map: 'Somewhere Else', isSeed: false },
          { layer: 'Other RAAS v1', map: 'Elsewhere', isSeed: false },
        ],
        settings: { selection: 'weighted_random', layerCooldown: 2, mapCooldown: 0 },
      }),
    );
    expect(result.pick).toBe('Bravo RAAS v1');
    expect(result.excluded).toEqual([{ layer: 'Alpha RAAS v1', reason: 'layer_cooldown' }]);
  });

  it('excludes maps within map cooldown', () => {
    const result = selectNextLayer(
      makeInput({
        recentMatches: [{ layer: 'Alpha AAS v9', map: 'Bravo RAAS v1 Map', isSeed: false }],
        settings: { selection: 'weighted_random', layerCooldown: 0, mapCooldown: 1 },
      }),
    );
    expect(result.pick).toBe('Alpha RAAS v1');
    expect(result.excluded).toEqual([{ layer: 'Bravo RAAS v1', reason: 'map_cooldown' }]);
  });

  it('ignores seed matches for cooldowns', () => {
    const result = selectNextLayer(
      makeInput({
        candidates: [candidate('Alpha RAAS v1')],
        recentMatches: [
          { layer: 'Alpha RAAS v1', map: 'Alpha RAAS v1 Map', isSeed: true },
          { layer: 'Alpha RAAS v1', map: 'Alpha RAAS v1 Map', isSeed: true },
        ],
        settings: { selection: 'weighted_random', layerCooldown: 5, mapCooldown: 5 },
      }),
    );
    expect(result.pick).toBe('Alpha RAAS v1');
    expect(result.excluded).toEqual([]);
  });

  it('excludes disabled and deprecated candidates', () => {
    const result = selectNextLayer(
      makeInput({
        candidates: [
          candidate('Alpha RAAS v1', { enabled: false }),
          candidate('Bravo RAAS v1', { deprecated: true }),
          candidate('Charlie AAS v2'),
        ],
      }),
    );
    expect(result.pick).toBe('Charlie AAS v2');
    expect(result.excluded).toEqual([
      { layer: 'Alpha RAAS v1', reason: 'disabled' },
      { layer: 'Bravo RAAS v1', reason: 'deprecated' },
    ]);
  });

  it('returns null pick with reason when pool is empty', () => {
    const empty = selectNextLayer(makeInput({ candidates: [] }));
    expect(empty).toEqual({ pick: null, reason: 'no_candidates', eligible: [], excluded: [] });

    const allExcluded = selectNextLayer(
      makeInput({ candidates: [candidate('Alpha RAAS v1', { enabled: false })] }),
    );
    expect(allExcluded.pick).toBeNull();
    expect(allExcluded.reason).toBe('all_excluded');
    expect(allExcluded.excluded).toEqual([{ layer: 'Alpha RAAS v1', reason: 'disabled' }]);
  });
});

describe('selectNextLayer (least_recently_played)', () => {
  it('picks the layer not played for the longest, preferring never-played layers', () => {
    const result = selectNextLayer(
      makeInput({
        candidates: [
          candidate('Alpha RAAS v1'),
          candidate('Bravo RAAS v1'),
          candidate('Charlie AAS v2'),
        ],
        recentMatches: [
          { layer: 'Alpha RAAS v1', map: 'Alpha RAAS v1 Map', isSeed: false },
          { layer: 'Bravo RAAS v1', map: 'Bravo RAAS v1 Map', isSeed: false },
        ],
        settings: { selection: 'least_recently_played', layerCooldown: 0, mapCooldown: 0 },
      }),
    );
    expect(result.pick).toBe('Charlie AAS v2');
    expect(result.eligible).toEqual([
      { layer: 'Alpha RAAS v1', weight: 1, probability: 0 },
      { layer: 'Bravo RAAS v1', weight: 1, probability: 0 },
      { layer: 'Charlie AAS v2', weight: 1, probability: 1 },
    ]);
  });

  it('prefers the older of two played layers and breaks never-played ties alphabetically', () => {
    const older = selectNextLayer(
      makeInput({
        recentMatches: [
          { layer: 'Alpha RAAS v1', map: 'Alpha RAAS v1 Map', isSeed: false },
          { layer: 'Bravo RAAS v1', map: 'Bravo RAAS v1 Map', isSeed: false },
        ],
        settings: { selection: 'least_recently_played', layerCooldown: 0, mapCooldown: 0 },
      }),
    );
    expect(older.pick).toBe('Bravo RAAS v1');

    const tie = selectNextLayer(
      makeInput({
        candidates: [candidate('Bravo RAAS v1'), candidate('Alpha RAAS v1')],
        settings: { selection: 'least_recently_played', layerCooldown: 0, mapCooldown: 0 },
      }),
    );
    expect(tie.pick).toBe('Alpha RAAS v1');
  });
});
