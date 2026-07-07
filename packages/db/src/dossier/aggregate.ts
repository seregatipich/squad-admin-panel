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
  sql: DossierSql,
  playerId: string,
  weapon: string,
  isTeamkill: boolean,
  occurredAt: Date,
): Promise<void> {
  const killInc = isTeamkill ? 0 : 1;
  const teamkillInc = isTeamkill ? 1 : 0;
  await sql`
    INSERT INTO player_weapon_stats
      (player_id, weapon, kills, teamkills, shots_events, damage, last_used_at)
    VALUES (${playerId}, ${weapon}, ${killInc}, ${teamkillInc}, 0, NULL, ${occurredAt})
    ON CONFLICT (player_id, weapon) DO UPDATE SET
      kills = player_weapon_stats.kills + ${killInc},
      teamkills = player_weapon_stats.teamkills + ${teamkillInc},
      last_used_at = GREATEST(player_weapon_stats.last_used_at, EXCLUDED.last_used_at)
  `;
}

async function upsertWeaponDamage(
  sql: DossierSql,
  playerId: string,
  weapon: string,
  damage: number | null,
  occurredAt: Date,
): Promise<void> {
  await sql`
    INSERT INTO player_weapon_stats
      (player_id, weapon, kills, teamkills, shots_events, damage, last_used_at)
    VALUES (${playerId}, ${weapon}, 0, 0, 1, ${damage}, ${occurredAt})
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
  sql: DossierSql,
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
  sql: DossierSql,
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
  sql: DossierSql,
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
 * @param sql - a connection or transaction; pass the transaction that inserts the event.
 * @param event - the combat event, projected to {@link DossierCombatEvent}.
 */
export async function applyCombatEventToDossier(
  sql: DossierSql,
  event: DossierCombatEvent,
): Promise<void> {
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
}

/**
 * Compares the stored dossier aggregates against a fresh recomputation from
 * `combat_events` and reports the drift; optionally repairs it.
 *
 * Report mode (default) is non-destructive and suitable for a scheduled guard
 * that alerts on discrepancies. Repair mode rebuilds the aggregate tables from
 * retained events and must be used deliberately (see {@link ReconcileOptions}).
 *
 * @returns per-table discrepancy counts and whether a repair was applied.
 */
export async function reconcileDossierAggregates(
  sql: postgres.Sql,
  options: ReconcileOptions = {},
): Promise<ReconcileResult> {
  const weaponStats = await countWeaponDrift(sql);
  const vehicleStats = await countVehicleStatsDrift(sql);
  const vehicleKills = await countVehicleKillsDrift(sql);
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
