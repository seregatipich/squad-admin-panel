import { sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  numeric,
  pgTable,
  primaryKey,
  text,
  uuid,
} from 'drizzle-orm/pg-core';
import { players } from './players.js';

/**
 * Per-player, per-vehicle "stats FROM the vehicle" aggregate (DOSSIER-2, issue #189).
 *
 * Counts kills and damage a player dealt while crewing a vehicle; the source is
 * `combat_events.attacker_vehicle` (DOSSIER-1). Keyed on `players.id` (uuid).
 * `damage` is nullable (see {@link playerWeaponStats}). Retention is indefinite.
 */
export const playerVehicleStats = pgTable(
  'player_vehicle_stats',
  {
    playerId: uuid('player_id')
      .notNull()
      .references(() => players.id, { onDelete: 'cascade' }),
    vehicleAssetId: text('vehicle_asset_id').notNull(),
    kills: integer('kills').notNull().default(0),
    damage: numeric('damage'),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.playerId, table.vehicleAssetId] }),
    killsIdx: index('player_vehicle_stats_kills_idx').on(table.playerId, table.kills.desc()),
    countsChk: check('player_vehicle_stats_counts_chk', sql`kills >= 0`),
  }),
);

export type PlayerVehicleStatRow = typeof playerVehicleStats.$inferSelect;
export type NewPlayerVehicleStat = typeof playerVehicleStats.$inferInsert;
