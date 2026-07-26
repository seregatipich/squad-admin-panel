/**
 * GAME-1 (#80) pure map auto-selection rule, shared by the API preview route
 * and the scheduler tick so both always agree on the same decision. See
 * ai_docs/adr/2026-07-09-map-rotation-managed-vs-native.md — "automatic
 * voting" is panel-driven candidate selection + `AdminSetNextLayer`.
 */

/** Selection rules supported by `selectNextLayer`. */
export type MapVoteSelection = 'weighted_random' | 'least_recently_played';

/** Why a candidate was left out of the eligible pool. */
export type MapVoteExclusionReason = 'disabled' | 'deprecated' | 'layer_cooldown' | 'map_cooldown';

export interface MapVoteSelectionInput {
  /** The server's candidate pool, enriched with catalog map/deprecated data. */
  candidates: Array<{
    layer: string;
    map: string;
    weight: number;
    enabled: boolean;
    deprecated: boolean;
  }>;
  /** Match history, newest first. Seed rounds never count toward cooldowns. */
  recentMatches: Array<{ layer: string; map: string; isSeed: boolean }>;
  settings: { selection: MapVoteSelection; layerCooldown: number; mapCooldown: number };
  /** Deterministic RNG seed — the same seed always yields the same pick. */
  seed: string;
}

export interface MapVoteSelectionResult {
  pick: string | null;
  /** Set only when `pick` is null: 'no_candidates' | 'all_excluded'. */
  reason?: string;
  eligible: Array<{ layer: string; weight: number; probability: number }>;
  excluded: Array<{ layer: string; reason: string }>;
}

/**
 * Deterministic [0, 1) random derived from a string seed: FNV-1a 32-bit hash
 * fed through one mulberry32 step. Not cryptographic — only reproducibility
 * matters, so a recorded `rng_seed` replays the exact pick.
 */
function seededRandom(seed: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  let t = (h + 0x6d2b79f5) | 0;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

/**
 * Picks the next layer from a candidate pool.
 *
 * Cooldowns look at the last N non-seed matches (newest first): a candidate
 * is excluded when its layer appears within `layerCooldown` matches or its
 * map within `mapCooldown` matches. `weighted_random` then draws by weight
 * using the seeded RNG; `least_recently_played` picks the eligible layer
 * whose last non-seed play is oldest (never played wins, ties break
 * alphabetically). Pure — no I/O, no ambient randomness.
 */
export function selectNextLayer(input: MapVoteSelectionInput): MapVoteSelectionResult {
  const { candidates, settings } = input;
  const nonSeed = input.recentMatches.filter((m) => !m.isSeed);
  const recentLayers = new Set(
    nonSeed.slice(0, Math.max(0, settings.layerCooldown)).map((m) => m.layer),
  );
  const recentMaps = new Set(nonSeed.slice(0, Math.max(0, settings.mapCooldown)).map((m) => m.map));

  const pool: MapVoteSelectionInput['candidates'] = [];
  const excluded: Array<{ layer: string; reason: string }> = [];
  for (const c of candidates) {
    const reason: MapVoteExclusionReason | null = !c.enabled
      ? 'disabled'
      : c.deprecated
        ? 'deprecated'
        : recentLayers.has(c.layer)
          ? 'layer_cooldown'
          : recentMaps.has(c.map)
            ? 'map_cooldown'
            : null;
    if (reason === null) pool.push(c);
    else excluded.push({ layer: c.layer, reason });
  }

  if (pool.length === 0) {
    return {
      pick: null,
      reason: candidates.length === 0 ? 'no_candidates' : 'all_excluded',
      eligible: [],
      excluded,
    };
  }

  if (settings.selection === 'least_recently_played') {
    const lastPlayed = (layer: string): number => {
      const idx = nonSeed.findIndex((m) => m.layer === layer);
      return idx === -1 ? Number.POSITIVE_INFINITY : idx;
    };
    let best = pool[0] as MapVoteSelectionInput['candidates'][number];
    for (const c of pool.slice(1)) {
      const age = lastPlayed(c.layer);
      const bestAge = lastPlayed(best.layer);
      if (age > bestAge || (age === bestAge && c.layer < best.layer)) best = c;
    }
    return {
      pick: best.layer,
      eligible: pool.map((c) => ({
        layer: c.layer,
        weight: c.weight,
        probability: c.layer === best.layer ? 1 : 0,
      })),
      excluded,
    };
  }

  const totalWeight = pool.reduce((sum, c) => sum + c.weight, 0);
  let cursor = seededRandom(input.seed) * totalWeight;
  let picked = pool[pool.length - 1] as MapVoteSelectionInput['candidates'][number];
  for (const c of pool) {
    cursor -= c.weight;
    if (cursor < 0) {
      picked = c;
      break;
    }
  }
  return {
    pick: picked.layer,
    eligible: pool.map((c) => ({
      layer: c.layer,
      weight: c.weight,
      probability: c.weight / totalWeight,
    })),
    excluded,
  };
}
