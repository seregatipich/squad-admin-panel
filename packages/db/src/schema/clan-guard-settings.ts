import { sql } from 'drizzle-orm';
import { boolean, check, integer, pgTable, smallint, timestamp, uuid } from 'drizzle-orm/pg-core';
import { players } from './players.js';

/** Default grace period (CLAN-5): re-detection window before an unrecognized impostor is kicked. */
export const CLAN_GUARD_DEFAULT_GRACE_PERIOD_SECONDS = 300;

/**
 * Singleton settings row (CLAN-5) holding the clan-tag-protection guard's
 * kill-switch and grace period: when `enabled` is false the clan-guard worker
 * skips its tick entirely (no warns/kicks); when true, an unrecognized player
 * wearing a protected clan's tag is warned immediately and kicked once
 * `gracePeriodSeconds` has elapsed since the warn (unless they hold panel
 * access, in which case they are only re-warned — see clan-guard worker).
 * Mirrors the `coplay_settings` / `economy_settings` singleton pattern.
 */
export const clanGuardSettings = pgTable(
  'clan_guard_settings',
  {
    id: smallint('id').primaryKey().default(1),
    enabled: boolean('enabled').notNull().default(true),
    gracePeriodSeconds: integer('grace_period_seconds')
      .notNull()
      .default(CLAN_GUARD_DEFAULT_GRACE_PERIOD_SECONDS),
    updatedByPlayerId: uuid('updated_by_player_id').references(() => players.id, {
      onDelete: 'set null',
    }),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
  },
  (table) => ({
    singleton: check('clan_guard_settings_singleton', sql`${table.id} = 1`),
    gracePeriodNonneg: check(
      'clan_guard_settings_grace_period_nonneg',
      sql`${table.gracePeriodSeconds} >= 0`,
    ),
  }),
);

export type ClanGuardSettingsRow = typeof clanGuardSettings.$inferSelect;
export type NewClanGuardSettings = typeof clanGuardSettings.$inferInsert;
