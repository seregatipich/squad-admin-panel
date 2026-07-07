import { sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  numeric,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { players } from './players.js';

/**
 * Per-player, per-weapon dossier aggregate (DOSSIER-2, issue #189).
 *
 * Keyed on `players.id` (uuid), not steam_id64, so EOS-only players aggregate
 * correctly. `damage` is nullable: when the source log line carries no damage
 * magnitude the aggregate keeps only counters and the UI renders "—". Retention
 * is indefinite — the table survives the 24-month `combat_events` partition drops.
 */
export const playerWeaponStats = pgTable(
  'player_weapon_stats',
  {
    playerId: uuid('player_id')
      .notNull()
      .references(() => players.id, { onDelete: 'cascade' }),
    weapon: text('weapon').notNull(),
    kills: integer('kills').notNull().default(0),
    teamkills: integer('teamkills').notNull().default(0),
    damage: numeric('damage'),
    shotsEvents: integer('shots_events').notNull().default(0),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true, mode: 'date' }),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.playerId, table.weapon] }),
    killsIdx: index('player_weapon_stats_kills_idx').on(table.playerId, table.kills.desc()),
    countsChk: check(
      'player_weapon_stats_counts_chk',
      sql`kills >= 0 AND teamkills >= 0 AND shots_events >= 0`,
    ),
  }),
);

export type PlayerWeaponStatRow = typeof playerWeaponStats.$inferSelect;
export type NewPlayerWeaponStat = typeof playerWeaponStats.$inferInsert;
