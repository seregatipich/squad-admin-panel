import { sql } from 'drizzle-orm';
import { check, integer, pgTable, smallint, timestamp, uuid } from 'drizzle-orm/pg-core';
import { players } from './players.js';

/** Default noise-floor thresholds for the co-play graph (ALT-3): 5 shared sessions / 10 hours. */
export const COPLAY_DEFAULT_MIN_SHARED_SESSIONS = 5;
export const COPLAY_DEFAULT_MIN_OVERLAP_SECONDS = 36_000;

/**
 * Singleton settings row (ALT-3) holding the two noise-floor thresholds applied
 * when serving the co-play graph: a pair is only returned when its rolling-window
 * `shared_session_count >= minSharedSessions` AND `overlap_seconds >= minOverlapSeconds`.
 * Mirrors the `economy_settings` / `geoip_settings` singleton pattern.
 */
export const coplaySettings = pgTable(
  'coplay_settings',
  {
    id: smallint('id').primaryKey().default(1),
    minSharedSessions: integer('min_shared_sessions')
      .notNull()
      .default(COPLAY_DEFAULT_MIN_SHARED_SESSIONS),
    minOverlapSeconds: integer('min_overlap_seconds')
      .notNull()
      .default(COPLAY_DEFAULT_MIN_OVERLAP_SECONDS),
    updatedByPlayerId: uuid('updated_by_player_id').references(() => players.id, {
      onDelete: 'set null',
    }),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
  },
  (table) => ({
    singleton: check('coplay_settings_singleton', sql`${table.id} = 1`),
    minSharedNonneg: check(
      'coplay_settings_min_shared_nonneg',
      sql`${table.minSharedSessions} >= 0`,
    ),
    minOverlapNonneg: check(
      'coplay_settings_min_overlap_nonneg',
      sql`${table.minOverlapSeconds} >= 0`,
    ),
  }),
);

export type CoplaySettingsRow = typeof coplaySettings.$inferSelect;
export type NewCoplaySettings = typeof coplaySettings.$inferInsert;
