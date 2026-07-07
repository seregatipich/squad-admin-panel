import { sql } from 'drizzle-orm';
import { check, index, integer, pgTable, primaryKey, text, uuid } from 'drizzle-orm/pg-core';
import { players } from './players.js';

/**
 * Per-player vehicle-destruction aggregate (DOSSIER-2, issue #189).
 *
 * Counts how many vehicles of each asset type a player destroyed, broken down by
 * the weapon used. Source is `combat_events` rows with `event_type =
 * 'vehicle_destroyed'` (victim vehicle from `victim_vehicle`). Keyed on
 * `players.id` (uuid). Retention is indefinite.
 */
export const playerVehicleKills = pgTable(
  'player_vehicle_kills',
  {
    playerId: uuid('player_id')
      .notNull()
      .references(() => players.id, { onDelete: 'cascade' }),
    victimVehicleAssetId: text('victim_vehicle_asset_id').notNull(),
    weapon: text('weapon').notNull(),
    destroyedCount: integer('destroyed_count').notNull().default(0),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.playerId, table.victimVehicleAssetId, table.weapon] }),
    countIdx: index('player_vehicle_kills_count_idx').on(
      table.playerId,
      table.destroyedCount.desc(),
    ),
    countsChk: check('player_vehicle_kills_counts_chk', sql`destroyed_count >= 0`),
  }),
);

export type PlayerVehicleKillRow = typeof playerVehicleKills.$inferSelect;
export type NewPlayerVehicleKill = typeof playerVehicleKills.$inferInsert;
