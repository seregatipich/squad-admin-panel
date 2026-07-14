/**
 * Per-server seeding state machine (SEED-1, #140).
 *
 * A server is considered "seeding" when its player count is below a
 * configurable `live_at` threshold, or when its current layer is a
 * dedicated seed layer (e.g. "Sumari Seed v1"). A hysteresis band around
 * `live_at` prevents the state from flapping when the player count
 * oscillates right at the boundary.
 *
 * This module is pure (no I/O) so it can be unit-tested directly; the
 * caller (`supervisor.ts`) is responsible for feeding it poll results and
 * persisting/publishing the resulting transitions.
 */

export type SeedingStateName = 'seeding' | 'live';

export interface SeedingState {
  state: SeedingStateName;
  /** ISO timestamp the current seeding period started, or null while live. */
  started_at: string | null;
  current_players: number;
  live_at: number;
  progress_pct: number;
  layer: string | null;
  updated_at: string;
}

export interface SeedingTickInput {
  playerCount: number;
  seedLayer: boolean;
  liveAt: number;
  hysteresis: number;
  /** ISO timestamp of this poll. */
  now: string;
  layer?: string | null;
}

export type SeedingTransition = 'started' | 'ended' | null;

export interface SeedingTickResult {
  state: SeedingState;
  transition: SeedingTransition;
}

/**
 * Resolves whether a layer counts as a "seed" layer. The layers catalog
 * (`is_seed` column, ROT-1) is authoritative when the layer is known —
 * both `true` and `false` override the name-based fallback. When the
 * layer is missing from the catalog (`catalogIsSeed === null`), fall back
 * to a `/seed/i` match against the layer name.
 */
export function isSeedLayer(layerName: string | null, catalogIsSeed: boolean | null): boolean {
  if (catalogIsSeed !== null) return catalogIsSeed;
  if (!layerName) return false;
  return /seed/i.test(layerName);
}

function computeProgressPct(playerCount: number, liveAt: number): number {
  if (liveAt <= 0) return 100;
  return Math.min(100, Math.max(0, Math.floor((playerCount / liveAt) * 100)));
}

/**
 * Advances the seeding state machine by one poll tick.
 *
 * - `prev === null` (worker just started tracking this server): the state
 *   is derived directly from the current poll with no hysteresis applied,
 *   since there is no prior state to debounce against. If that initial
 *   evaluation is "seeding", a `started` transition is emitted so
 *   downstream consumers (events table, live-bus, UI) learn about an
 *   already-seeding server instead of silently missing it.
 * - `live -> seeding`: triggered when the player count drops below
 *   `liveAt - hysteresis`, OR the current layer is a seed layer.
 * - `seeding -> live`: triggered only when the player count reaches
 *   `liveAt` AND the current layer is not a seed layer (a seed layer keeps
 *   the server in seeding state even at full population, matching
 *   acceptance criterion 2).
 */
export function computeSeedingTick(
  prev: SeedingState | null,
  input: SeedingTickInput,
): SeedingTickResult {
  const { playerCount, seedLayer, liveAt, hysteresis, now } = input;
  const layer = input.layer ?? null;
  const progressPct = computeProgressPct(playerCount, liveAt);

  if (prev === null) {
    const seeding = playerCount < liveAt || seedLayer;
    return {
      state: {
        state: seeding ? 'seeding' : 'live',
        started_at: seeding ? now : null,
        current_players: playerCount,
        live_at: liveAt,
        progress_pct: progressPct,
        layer,
        updated_at: now,
      },
      transition: seeding ? 'started' : null,
    };
  }

  if (prev.state === 'live') {
    const enterSeeding = playerCount < liveAt - hysteresis || seedLayer;
    if (enterSeeding) {
      return {
        state: {
          state: 'seeding',
          started_at: now,
          current_players: playerCount,
          live_at: liveAt,
          progress_pct: progressPct,
          layer,
          updated_at: now,
        },
        transition: 'started',
      };
    }
    return {
      state: {
        ...prev,
        current_players: playerCount,
        progress_pct: progressPct,
        layer,
        updated_at: now,
      },
      transition: null,
    };
  }

  // prev.state === 'seeding'
  const exitToLive = playerCount >= liveAt && !seedLayer;
  if (exitToLive) {
    return {
      state: {
        state: 'live',
        started_at: null,
        current_players: playerCount,
        live_at: liveAt,
        progress_pct: progressPct,
        layer,
        updated_at: now,
      },
      transition: 'ended',
    };
  }
  return {
    state: {
      ...prev,
      current_players: playerCount,
      progress_pct: progressPct,
      layer,
      updated_at: now,
    },
    transition: null,
  };
}
