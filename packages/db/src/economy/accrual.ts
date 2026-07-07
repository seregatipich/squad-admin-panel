import type postgres from 'postgres';

const SECONDS_PER_HOUR = 3600;
const DAY_SECONDS = 86_400;

/** Ledger reference type used for machine-generated daily presence accruals. */
export const DAILY_PRESENCE_REFERENCE_TYPE = 'daily_presence';

/** Bonus transaction types written by the daily accrual job. */
export const ACCRUAL_TX_TYPES = ['earn_online', 'earn_boost', 'earn_seed'] as const;

/**
 * A single connected session, clipped to the accrual window, used to derive
 * seed time. `startSec`/`endSec` are epoch seconds; only sessions the player
 * was actually on the server for (online/boost, not queue) should be passed.
 */
export interface SeedSessionInterval {
  playerId: string;
  serverId: string;
  startSec: number;
  endSec: number;
}

/**
 * Compute, per `player_id|server_id`, the number of seconds each player was
 * connected while the concurrent player count on that server was strictly below
 * `threshold` ("seed" time — keeping a low-population server alive).
 *
 * A sweep line over the session boundaries splits the window into intervals of
 * constant concurrency; every interval whose active-session count is below the
 * threshold contributes its duration to each session active in it. Intervals
 * must already be clipped to the target window. Concurrency is measured as the
 * number of overlapping sessions (one per connected player).
 *
 * @param intervals connected sessions clipped to the window
 * @param threshold population below which time counts as seed time
 * @returns map keyed by `${playerId}|${serverId}` → seed seconds (integer)
 */
export function computeSeedSecondsByPlayerServer(
  intervals: SeedSessionInterval[],
  threshold: number,
): Map<string, number> {
  const result = new Map<string, number>();
  if (threshold <= 0) return result;

  const byServer = new Map<string, SeedSessionInterval[]>();
  for (const interval of intervals) {
    if (interval.endSec <= interval.startSec) continue;
    let list = byServer.get(interval.serverId);
    if (!list) {
      list = [];
      byServer.set(interval.serverId, list);
    }
    list.push(interval);
  }

  for (const list of byServer.values()) {
    const boundaries = new Set<number>();
    for (const interval of list) {
      boundaries.add(interval.startSec);
      boundaries.add(interval.endSec);
    }
    const sorted = [...boundaries].sort((a, b) => a - b);
    for (let i = 0; i < sorted.length - 1; i += 1) {
      const from = sorted[i];
      const to = sorted[i + 1];
      if (from === undefined || to === undefined) continue;
      const active = list.filter((s) => s.startSec <= from && s.endSec >= to);
      if (active.length === 0 || active.length >= threshold) continue;
      const duration = to - from;
      for (const s of active) {
        const key = `${s.playerId}|${s.serverId}`;
        result.set(key, (result.get(key) ?? 0) + duration);
      }
    }
  }
  return result;
}

export interface AccrueDailyBonusesInput {
  /** UTC day to accrue, `YYYY-MM-DD`. */
  day: string;
  /** Reference clock; open sessions are treated as ending at `now`. */
  now?: Date;
}

export interface AccrueDailyBonusesResult {
  day: string;
  /** False when `economy_settings.economy_enabled` is off — nothing is written. */
  economyEnabled: boolean;
  /** Distinct players whose ledger changed on this run. */
  playersAccrued: number;
  /** Number of `earn_*` ledger rows written this run. */
  transactionsWritten: number;
  /** Net change applied to `players.bonus_balance` across all players. */
  balanceDelta: number;
}

interface SettingsRow {
  k_online: number;
  k_boost: number;
  k_seed: number;
  seed_threshold: number;
  economy_enabled: boolean;
}

interface SessionRow {
  player_id: string;
  server_id: string;
  start_sec: number;
  end_sec: number;
}

interface PresenceAggRow {
  player_id: string;
  online_seconds: number;
  boost_seconds: number;
  seed_seconds: number;
}

/**
 * Accrue online/boost/seed bonuses for every player with presence on `day`.
 *
 * Runs after {@link recomputeDailyPresence} has (re)built `player_daily_presence`
 * for the day. Steps, all in one transaction:
 *  1. read `economy_settings`; if the economy is disabled, do nothing;
 *  2. derive `seed_seconds` per (player, server) from the day's connected
 *     sessions and the configured `seed_threshold`, and persist it into
 *     `player_daily_presence`;
 *  3. for each player, compute `round(k × seconds / 3600)` per bonus type and
 *     write one `earn_online`/`earn_boost`/`earn_seed` transaction each
 *     (`reference = (player_id, day)`), skipping zero amounts;
 *  4. keep `players.bonus_balance` in sync.
 *
 * Idempotent: existing accrual rows for the day are deleted and replaced, and
 * the balance is adjusted by the net delta, so re-running for the same day never
 * double-counts. Accruals are machine-generated and intentionally not written to
 * `audit_log`.
 *
 * @param sql postgres.js connection
 * @param input target day and reference clock
 * @returns a summary suitable for worker observability
 */
export async function accrueDailyBonuses(
  sql: postgres.Sql,
  input: AccrueDailyBonusesInput,
): Promise<AccrueDailyBonusesResult> {
  const { day } = input;
  const now = input.now ?? new Date();
  const dayStartSec = Math.floor(Date.parse(`${day}T00:00:00.000Z`) / 1000);
  if (!Number.isFinite(dayStartSec)) throw new Error(`invalid day: ${day}`);
  const dayEndSec = dayStartSec + DAY_SECONDS;

  return sql.begin(async (tx) => {
    const [settings] = await tx<SettingsRow[]>`
      SELECT k_online, k_boost, k_seed, seed_threshold, economy_enabled
      FROM economy_settings
      WHERE id = 1
    `;

    if (!settings || !settings.economy_enabled) {
      return {
        day,
        economyEnabled: false,
        playersAccrued: 0,
        transactionsWritten: 0,
        balanceDelta: 0,
      };
    }

    const kOnline = Number(settings.k_online);
    const kBoost = Number(settings.k_boost);
    const kSeed = Number(settings.k_seed);
    const seedThreshold = Number(settings.seed_threshold);

    const sessions = await tx<SessionRow[]>`
      SELECT
        player_id,
        server_id,
        EXTRACT(EPOCH FROM connected_at)::double precision AS start_sec,
        EXTRACT(EPOCH FROM COALESCE(disconnected_at, ${now}::timestamptz))::double precision AS end_sec
      FROM player_sessions
      WHERE COALESCE(mode, 'online') <> 'queue'
        AND connected_at < to_timestamp(${dayEndSec})
        AND COALESCE(disconnected_at, ${now}::timestamptz) > to_timestamp(${dayStartSec})
    `;

    const intervals: SeedSessionInterval[] = sessions.map((s) => ({
      playerId: s.player_id,
      serverId: s.server_id,
      startSec: Math.max(Math.floor(Number(s.start_sec)), dayStartSec),
      endSec: Math.min(Math.floor(Number(s.end_sec)), dayEndSec),
    }));
    const seedByKey = computeSeedSecondsByPlayerServer(intervals, seedThreshold);

    await tx`UPDATE player_daily_presence SET seed_seconds = 0 WHERE day = ${day}::date`;
    for (const [key, seconds] of seedByKey) {
      const [playerId, serverId] = key.split('|');
      if (!playerId || !serverId) continue;
      await tx`
        UPDATE player_daily_presence
        SET seed_seconds = ${seconds}
        WHERE day = ${day}::date
          AND player_id = ${playerId}::uuid
          AND server_id = ${serverId}::uuid
      `;
    }

    const aggregates = await tx<PresenceAggRow[]>`
      SELECT
        player_id,
        SUM(online_seconds)::bigint AS online_seconds,
        SUM(boost_seconds)::bigint AS boost_seconds,
        SUM(seed_seconds)::bigint AS seed_seconds
      FROM player_daily_presence
      WHERE day = ${day}::date
      GROUP BY player_id
    `;

    let playersAccrued = 0;
    let transactionsWritten = 0;
    let balanceDelta = 0;

    for (const row of aggregates) {
      const playerId = row.player_id;
      const desired: Array<{ type: (typeof ACCRUAL_TX_TYPES)[number]; amount: number }> = [
        {
          type: 'earn_online',
          amount: Math.round((kOnline * Number(row.online_seconds)) / SECONDS_PER_HOUR),
        },
        {
          type: 'earn_boost',
          amount: Math.round((kBoost * Number(row.boost_seconds)) / SECONDS_PER_HOUR),
        },
        {
          type: 'earn_seed',
          amount: Math.round((kSeed * Number(row.seed_seconds)) / SECONDS_PER_HOUR),
        },
      ];

      const removed = await tx<{ amount: number }[]>`
        DELETE FROM bonus_transactions
        WHERE player_id = ${playerId}::uuid
          AND reference_type = ${DAILY_PRESENCE_REFERENCE_TYPE}
          AND reference_id = ${day}
          AND type IN ('earn_online', 'earn_boost', 'earn_seed')
        RETURNING amount
      `;
      const removedSum = removed.reduce((acc, r) => acc + Number(r.amount), 0);

      let addedSum = 0;
      for (const { type, amount } of desired) {
        if (amount === 0) continue;
        await tx`
          INSERT INTO bonus_transactions
            (player_id, amount, type, reference_type, reference_id)
          VALUES
            (${playerId}::uuid, ${amount}, ${type}, ${DAILY_PRESENCE_REFERENCE_TYPE}, ${day})
        `;
        addedSum += amount;
        transactionsWritten += 1;
      }

      const delta = addedSum - removedSum;
      if (delta !== 0) {
        await tx`
          UPDATE players
          SET bonus_balance = bonus_balance + ${delta}, updated_at = now()
          WHERE id = ${playerId}::uuid
        `;
        balanceDelta += delta;
      }
      if (addedSum !== 0 || removedSum !== 0) playersAccrued += 1;
    }

    return { day, economyEnabled: true, playersAccrued, transactionsWritten, balanceDelta };
  });
}

/**
 * Inclusive list of UTC day keys spanning `[fromDay, toDay]`.
 * Used by the worker to accrue every finalized day in the recompute window.
 */
export function daysInWindow(fromDay: string, toDay: string): string[] {
  const fromMs = Date.parse(`${fromDay}T00:00:00.000Z`);
  const toMs = Date.parse(`${toDay}T00:00:00.000Z`);
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs < fromMs) return [];
  const days: string[] = [];
  for (let ms = fromMs; ms <= toMs; ms += DAY_SECONDS * 1000) {
    days.push(new Date(ms).toISOString().slice(0, 10));
  }
  return days;
}
