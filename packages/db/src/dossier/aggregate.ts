import { sql as drizzleSql } from 'drizzle-orm';
import type postgres from 'postgres';
import type { CombatEventType } from '../schema/combat-events.js';

/**
 * DOSSIER-2 (#189): per-weapon and per-vehicle dossier aggregation.
 *
 * Two update paths keep the three aggregate tables (`player_weapon_stats`,
 * `player_vehicle_stats`, `player_vehicle_kills`) current:
 *
 * 1. **Incremental** — {@link applyCombatEventToDossier} UPSERTs the aggregates
 *    for a single `combat_events` row. A log-ingest writer calls it in the SAME
 *    transaction as the `combat_events` insert so a kill is reflected in the
 *    dossier within seconds. Because the aggregates live in their own tables,
 *    dropping a 24-month-old `combat_events` partition never touches them — this
 *    is how the dossier keeps multi-year history.
 * 2. **Reconcile** — {@link reconcileDossierAggregates} recomputes the expected
 *    aggregates from the currently-retained `combat_events` and reports (or, when
 *    `repair` is set, restores) any drift, guarding against events missed while a
 *    worker was down. Report mode is safe to run on a schedule; repair rebuilds
 *    from retained events only and is therefore an explicit, opt-in operation.
 */

/** Minimal executor accepted by the aggregation helpers — a connection or a transaction. */
export type DossierSql = postgres.Sql | postgres.TransactionSql;

/**
 * A drizzle connection or transaction able to run a parametrized statement.
 * Matches the postgres-js drizzle client's `execute(sql`…`)` shape so log-ingest
 * can fold a combat event into the aggregates on the same drizzle transaction
 * that inserts the `combat_events` row.
 */
export interface DossierDrizzleExecutor {
  execute(query: unknown): Promise<unknown>;
}

/**
 * Executor accepted by {@link applyCombatEventToDossier}: a postgres.js
 * connection/transaction (used by the reconcile path and the DB tests) or a
 * drizzle connection/transaction (used by the log-ingest writer).
 */
export type DossierExecutor = DossierSql | DossierDrizzleExecutor;

/** A tagged-template SQL runner shared by both executor kinds. */
type SqlRunner = (strings: TemplateStringsArray, ...values: unknown[]) => Promise<unknown>;

/**
 * Normalizes either executor kind to a tagged-template runner. postgres.js `Sql`
 * is itself callable as a tagged template; a drizzle executor is wrapped so the
 * same `` sql`…` `` call sites route through `execute(drizzleSql`…`)`.
 */
function toSqlRunner(exec: DossierExecutor): SqlRunner {
  if (typeof exec === 'function') {
    const run = exec as (strings: TemplateStringsArray, ...values: unknown[]) => Promise<unknown>;
    return (strings, ...values) => run(strings, ...values);
  }
  const drizzle = exec as DossierDrizzleExecutor;
  return (strings, ...values) => drizzle.execute(drizzleSql(strings, ...values));
}

/** A `combat_events` row projected to the fields the dossier aggregation needs. */
export interface DossierCombatEvent {
  eventType: CombatEventType;
  attackerPlayerId: string | null;
  weapon: string | null;
  attackerVehicle: string | null;
  victimVehicle: string | null;
  /** Damage magnitude, or null when the source log line carried none. */
  damage: number | null;
  isTeamkill: boolean;
  occurredAt: Date;
}

async function upsertWeaponKill(
  sql: SqlRunner,
  playerId: string,
  weapon: string,
  isTeamkill: boolean,
  occurredAt: Date,
): Promise<void> {
  const killInc = isTeamkill ? 0 : 1;
  const teamkillInc = isTeamkill ? 1 : 0;
  // Bind timestamps as ISO strings cast with ::timestamptz: postgres.js accepts a
  // raw Date, but the drizzle `execute(sql`…`)` path cannot serialize one.
  await sql`
    INSERT INTO player_weapon_stats
      (player_id, weapon, kills, teamkills, shots_events, damage, last_used_at)
    VALUES (${playerId}, ${weapon}, ${killInc}, ${teamkillInc}, 0, NULL, ${occurredAt.toISOString()}::timestamptz)
    ON CONFLICT (player_id, weapon) DO UPDATE SET
      kills = player_weapon_stats.kills + ${killInc},
      teamkills = player_weapon_stats.teamkills + ${teamkillInc},
      last_used_at = GREATEST(player_weapon_stats.last_used_at, EXCLUDED.last_used_at)
  `;
}

async function upsertWeaponDamage(
  sql: SqlRunner,
  playerId: string,
  weapon: string,
  damage: number | null,
  occurredAt: Date,
): Promise<void> {
  await sql`
    INSERT INTO player_weapon_stats
      (player_id, weapon, kills, teamkills, shots_events, damage, last_used_at)
    VALUES (${playerId}, ${weapon}, 0, 0, 1, ${damage}, ${occurredAt.toISOString()}::timestamptz)
    ON CONFLICT (player_id, weapon) DO UPDATE SET
      shots_events = player_weapon_stats.shots_events + 1,
      damage = CASE
        WHEN EXCLUDED.damage IS NULL THEN player_weapon_stats.damage
        ELSE COALESCE(player_weapon_stats.damage, 0) + EXCLUDED.damage
      END,
      last_used_at = GREATEST(player_weapon_stats.last_used_at, EXCLUDED.last_used_at)
  `;
}

async function upsertVehicleKill(
  sql: SqlRunner,
  playerId: string,
  vehicleAssetId: string,
): Promise<void> {
  await sql`
    INSERT INTO player_vehicle_stats (player_id, vehicle_asset_id, kills, damage)
    VALUES (${playerId}, ${vehicleAssetId}, 1, NULL)
    ON CONFLICT (player_id, vehicle_asset_id) DO UPDATE SET
      kills = player_vehicle_stats.kills + 1
  `;
}

async function upsertVehicleDamage(
  sql: SqlRunner,
  playerId: string,
  vehicleAssetId: string,
  damage: number | null,
): Promise<void> {
  await sql`
    INSERT INTO player_vehicle_stats (player_id, vehicle_asset_id, kills, damage)
    VALUES (${playerId}, ${vehicleAssetId}, 0, ${damage})
    ON CONFLICT (player_id, vehicle_asset_id) DO UPDATE SET
      damage = CASE
        WHEN EXCLUDED.damage IS NULL THEN player_vehicle_stats.damage
        ELSE COALESCE(player_vehicle_stats.damage, 0) + EXCLUDED.damage
      END
  `;
}

async function upsertVehicleDestroyed(
  sql: SqlRunner,
  playerId: string,
  victimVehicleAssetId: string,
  weapon: string,
): Promise<void> {
  await sql`
    INSERT INTO player_vehicle_kills
      (player_id, victim_vehicle_asset_id, weapon, destroyed_count)
    VALUES (${playerId}, ${victimVehicleAssetId}, ${weapon}, 1)
    ON CONFLICT (player_id, victim_vehicle_asset_id, weapon) DO UPDATE SET
      destroyed_count = player_vehicle_kills.destroyed_count + 1
  `;
}

/**
 * Incrementally folds a single combat event into the dossier aggregates.
 *
 * Idempotency is the caller's responsibility: invoke this exactly once per
 * `combat_events` insert (i.e. only when the insert actually happened, inside the
 * same transaction), otherwise counters double-count. Events that cannot map to a
 * player (`attackerPlayerId` null) or carry no weapon/vehicle are ignored.
 *
 * @param exec - a postgres.js or drizzle connection/transaction; pass the
 *   transaction that inserts the event so the fold is atomic with it.
 * @param event - the combat event, projected to {@link DossierCombatEvent}.
 */
export async function applyCombatEventToDossier(
  exec: DossierExecutor,
  event: DossierCombatEvent,
): Promise<void> {
  const sql = toSqlRunner(exec);
  const { attackerPlayerId, weapon, attackerVehicle, victimVehicle, occurredAt } = event;

  if (event.eventType === 'death') {
    if (!attackerPlayerId || !weapon) return;
    await upsertWeaponKill(sql, attackerPlayerId, weapon, event.isTeamkill, occurredAt);
    if (attackerVehicle && !event.isTeamkill) {
      await upsertVehicleKill(sql, attackerPlayerId, attackerVehicle);
    }
    return;
  }

  if (event.eventType === 'damage') {
    if (!attackerPlayerId || !weapon) return;
    await upsertWeaponDamage(sql, attackerPlayerId, weapon, event.damage, occurredAt);
    if (attackerVehicle) {
      await upsertVehicleDamage(sql, attackerPlayerId, attackerVehicle, event.damage);
    }
    return;
  }

  if (event.eventType === 'vehicle_destroyed') {
    if (!attackerPlayerId || !victimVehicle || !weapon) return;
    await upsertVehicleDestroyed(sql, attackerPlayerId, victimVehicle, weapon);
  }
}

/** Per-table drift counts returned by {@link reconcileDossierAggregates}. */
export interface DossierDiscrepancies {
  weaponStats: number;
  vehicleStats: number;
  vehicleKills: number;
  total: number;
}

export interface ReconcileResult {
  discrepancies: DossierDiscrepancies;
  repaired: boolean;
}

async function countWeaponDrift(sql: DossierSql): Promise<number> {
  const rows = await sql<{ n: number }[]>`
    WITH expected AS (
      SELECT attacker_player_id AS player_id, weapon,
        COUNT(*) FILTER (WHERE event_type = 'death' AND NOT is_teamkill)::int AS kills,
        COUNT(*) FILTER (WHERE event_type = 'death' AND is_teamkill)::int AS teamkills,
        SUM(damage) FILTER (WHERE event_type = 'damage') AS damage,
        COUNT(*) FILTER (WHERE event_type = 'damage')::int AS shots_events,
        MAX(occurred_at) AS last_used_at
      FROM combat_events
      WHERE attacker_player_id IS NOT NULL AND weapon IS NOT NULL
        AND event_type IN ('death', 'damage')
      GROUP BY attacker_player_id, weapon
    )
    SELECT COUNT(*)::int AS n
    FROM expected e
    FULL OUTER JOIN player_weapon_stats s
      ON s.player_id = e.player_id AND s.weapon = e.weapon
    WHERE e.player_id IS NULL OR s.player_id IS NULL
      OR e.kills IS DISTINCT FROM s.kills
      OR e.teamkills IS DISTINCT FROM s.teamkills
      OR e.shots_events IS DISTINCT FROM s.shots_events
      OR e.damage IS DISTINCT FROM s.damage
      OR e.last_used_at IS DISTINCT FROM s.last_used_at
  `;
  return rows[0]?.n ?? 0;
}

async function countVehicleStatsDrift(sql: DossierSql): Promise<number> {
  const rows = await sql<{ n: number }[]>`
    WITH expected AS (
      SELECT attacker_player_id AS player_id, attacker_vehicle AS vehicle_asset_id,
        COUNT(*) FILTER (WHERE event_type = 'death')::int AS kills,
        SUM(damage) FILTER (WHERE event_type = 'damage') AS damage
      FROM combat_events
      WHERE attacker_player_id IS NOT NULL AND attacker_vehicle IS NOT NULL
        AND ((event_type = 'death' AND NOT is_teamkill) OR event_type = 'damage')
      GROUP BY attacker_player_id, attacker_vehicle
    )
    SELECT COUNT(*)::int AS n
    FROM expected e
    FULL OUTER JOIN player_vehicle_stats s
      ON s.player_id = e.player_id AND s.vehicle_asset_id = e.vehicle_asset_id
    WHERE e.player_id IS NULL OR s.player_id IS NULL
      OR e.kills IS DISTINCT FROM s.kills
      OR e.damage IS DISTINCT FROM s.damage
  `;
  return rows[0]?.n ?? 0;
}

async function countVehicleKillsDrift(sql: DossierSql): Promise<number> {
  const rows = await sql<{ n: number }[]>`
    WITH expected AS (
      SELECT attacker_player_id AS player_id, victim_vehicle AS victim_vehicle_asset_id, weapon,
        COUNT(*)::int AS destroyed_count
      FROM combat_events
      WHERE event_type = 'vehicle_destroyed'
        AND attacker_player_id IS NOT NULL AND victim_vehicle IS NOT NULL AND weapon IS NOT NULL
      GROUP BY attacker_player_id, victim_vehicle, weapon
    )
    SELECT COUNT(*)::int AS n
    FROM expected e
    FULL OUTER JOIN player_vehicle_kills s
      ON s.player_id = e.player_id
      AND s.victim_vehicle_asset_id = e.victim_vehicle_asset_id
      AND s.weapon = e.weapon
    WHERE e.player_id IS NULL OR s.player_id IS NULL
      OR e.destroyed_count IS DISTINCT FROM s.destroyed_count
  `;
  return rows[0]?.n ?? 0;
}

/**
 * Windowed drift counts restrict the recomputation to `combat_events` from the
 * last `windowHours` and only flag keys whose stored aggregate fails to reflect
 * that recent activity (row missing, or a counter below the windowed recompute).
 *
 * The comparison is deliberately expected-driven and "at least" rather than the
 * full-table equality: the stored aggregates are cumulative (they outlive the
 * 24-month `combat_events` retention), so a windowed recompute is always a lower
 * bound. This never false-positives on aged-out partitions or normal cumulative
 * history, while still catching the catastrophic gap the reconcile guards against
 * (an aggregate that never received a recent event). Over-counts relative to the
 * window are expected and ignored; `damage`/`last_used_at` are omitted because a
 * lower-bound check is only meaningful for the monotonically-growing counters.
 */
async function countWeaponDriftWindowed(sql: DossierSql, windowHours: number): Promise<number> {
  const rows = await sql<{ n: number }[]>`
    WITH expected AS (
      SELECT attacker_player_id AS player_id, weapon,
        COUNT(*) FILTER (WHERE event_type = 'death' AND NOT is_teamkill)::int AS kills,
        COUNT(*) FILTER (WHERE event_type = 'death' AND is_teamkill)::int AS teamkills,
        COUNT(*) FILTER (WHERE event_type = 'damage')::int AS shots_events
      FROM combat_events
      WHERE attacker_player_id IS NOT NULL AND weapon IS NOT NULL
        AND event_type IN ('death', 'damage')
        AND occurred_at >= now() - make_interval(hours => ${windowHours})
      GROUP BY attacker_player_id, weapon
    )
    SELECT COUNT(*)::int AS n
    FROM expected e
    LEFT JOIN player_weapon_stats s
      ON s.player_id = e.player_id AND s.weapon = e.weapon
    WHERE s.player_id IS NULL
      OR s.kills < e.kills
      OR s.teamkills < e.teamkills
      OR s.shots_events < e.shots_events
  `;
  return rows[0]?.n ?? 0;
}

async function countVehicleStatsDriftWindowed(
  sql: DossierSql,
  windowHours: number,
): Promise<number> {
  const rows = await sql<{ n: number }[]>`
    WITH expected AS (
      SELECT attacker_player_id AS player_id, attacker_vehicle AS vehicle_asset_id,
        COUNT(*) FILTER (WHERE event_type = 'death')::int AS kills
      FROM combat_events
      WHERE attacker_player_id IS NOT NULL AND attacker_vehicle IS NOT NULL
        AND ((event_type = 'death' AND NOT is_teamkill) OR event_type = 'damage')
        AND occurred_at >= now() - make_interval(hours => ${windowHours})
      GROUP BY attacker_player_id, attacker_vehicle
    )
    SELECT COUNT(*)::int AS n
    FROM expected e
    LEFT JOIN player_vehicle_stats s
      ON s.player_id = e.player_id AND s.vehicle_asset_id = e.vehicle_asset_id
    WHERE s.player_id IS NULL OR s.kills < e.kills
  `;
  return rows[0]?.n ?? 0;
}

async function countVehicleKillsDriftWindowed(
  sql: DossierSql,
  windowHours: number,
): Promise<number> {
  const rows = await sql<{ n: number }[]>`
    WITH expected AS (
      SELECT attacker_player_id AS player_id, victim_vehicle AS victim_vehicle_asset_id, weapon,
        COUNT(*)::int AS destroyed_count
      FROM combat_events
      WHERE event_type = 'vehicle_destroyed'
        AND attacker_player_id IS NOT NULL AND victim_vehicle IS NOT NULL AND weapon IS NOT NULL
        AND occurred_at >= now() - make_interval(hours => ${windowHours})
      GROUP BY attacker_player_id, victim_vehicle, weapon
    )
    SELECT COUNT(*)::int AS n
    FROM expected e
    LEFT JOIN player_vehicle_kills s
      ON s.player_id = e.player_id
      AND s.victim_vehicle_asset_id = e.victim_vehicle_asset_id
      AND s.weapon = e.weapon
    WHERE s.player_id IS NULL OR s.destroyed_count < e.destroyed_count
  `;
  return rows[0]?.n ?? 0;
}

async function rebuildFromEvents(sql: postgres.TransactionSql): Promise<void> {
  await sql`DELETE FROM player_weapon_stats`;
  await sql`
    INSERT INTO player_weapon_stats
      (player_id, weapon, kills, teamkills, damage, shots_events, last_used_at)
    SELECT attacker_player_id, weapon,
      COUNT(*) FILTER (WHERE event_type = 'death' AND NOT is_teamkill)::int,
      COUNT(*) FILTER (WHERE event_type = 'death' AND is_teamkill)::int,
      SUM(damage) FILTER (WHERE event_type = 'damage'),
      COUNT(*) FILTER (WHERE event_type = 'damage')::int,
      MAX(occurred_at)
    FROM combat_events
    WHERE attacker_player_id IS NOT NULL AND weapon IS NOT NULL
      AND event_type IN ('death', 'damage')
    GROUP BY attacker_player_id, weapon
  `;
  await sql`DELETE FROM player_vehicle_stats`;
  await sql`
    INSERT INTO player_vehicle_stats (player_id, vehicle_asset_id, kills, damage)
    SELECT attacker_player_id, attacker_vehicle,
      COUNT(*) FILTER (WHERE event_type = 'death')::int,
      SUM(damage) FILTER (WHERE event_type = 'damage')
    FROM combat_events
    WHERE attacker_player_id IS NOT NULL AND attacker_vehicle IS NOT NULL
      AND ((event_type = 'death' AND NOT is_teamkill) OR event_type = 'damage')
    GROUP BY attacker_player_id, attacker_vehicle
  `;
  await sql`DELETE FROM player_vehicle_kills`;
  await sql`
    INSERT INTO player_vehicle_kills
      (player_id, victim_vehicle_asset_id, weapon, destroyed_count)
    SELECT attacker_player_id, victim_vehicle, weapon, COUNT(*)::int
    FROM combat_events
    WHERE event_type = 'vehicle_destroyed'
      AND attacker_player_id IS NOT NULL AND victim_vehicle IS NOT NULL AND weapon IS NOT NULL
    GROUP BY attacker_player_id, victim_vehicle, weapon
  `;
}

export interface ReconcileOptions {
  /**
   * When true, rebuild the aggregate tables from the currently-retained
   * `combat_events` after measuring drift. Because the rebuild only sees retained
   * events, run repair mode only while the contributing partitions still exist.
   */
  repair?: boolean;
  /**
   * When set, restrict drift detection to `combat_events` from the last N hours
   * (the nightly guard uses 48). Windowed detection is a lower-bound check that
   * flags only aggregates failing to reflect recent activity, so it never
   * false-positives on aged-out partitions or normal cumulative history. Repair
   * still rebuilds from all retained events and ignores this window.
   */
  windowHours?: number;
}

/**
 * Compares the stored dossier aggregates against a fresh recomputation from
 * `combat_events` and reports the drift; optionally repairs it.
 *
 * Report mode (default) is non-destructive and suitable for a scheduled guard
 * that alerts on discrepancies. Repair mode rebuilds the aggregate tables from
 * retained events and must be used deliberately (see {@link ReconcileOptions}).
 *
 * With `windowHours` set, detection only considers events from the last N hours
 * (see {@link ReconcileOptions.windowHours}); without it, the full-table equality
 * recompute is used.
 *
 * @returns per-table discrepancy counts and whether a repair was applied.
 */
export async function reconcileDossierAggregates(
  sql: postgres.Sql,
  options: ReconcileOptions = {},
): Promise<ReconcileResult> {
  const { windowHours } = options;
  const weaponStats =
    windowHours != null
      ? await countWeaponDriftWindowed(sql, windowHours)
      : await countWeaponDrift(sql);
  const vehicleStats =
    windowHours != null
      ? await countVehicleStatsDriftWindowed(sql, windowHours)
      : await countVehicleStatsDrift(sql);
  const vehicleKills =
    windowHours != null
      ? await countVehicleKillsDriftWindowed(sql, windowHours)
      : await countVehicleKillsDrift(sql);
  const discrepancies: DossierDiscrepancies = {
    weaponStats,
    vehicleStats,
    vehicleKills,
    total: weaponStats + vehicleStats + vehicleKills,
  };

  if (options.repair && discrepancies.total > 0) {
    await sql.begin((tx) => rebuildFromEvents(tx));
    return { discrepancies, repaired: true };
  }

  return { discrepancies, repaired: false };
}
