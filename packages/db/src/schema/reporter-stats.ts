import { boolean, index, integer, pgTable, real, timestamp, uuid } from 'drizzle-orm/pg-core';
import { players } from './players.js';

/**
 * Materialized per-reporter trust metrics (REPORT-5, #115). Recomputed by
 * `recomputeReporterStats` (apps/api/src/lib/reporter-stats.ts) whenever a
 * report authored by this player changes status (resolve/reject/reopen) or
 * gains/loses a linked `moderation_actions` row.
 *
 * `accuracy` is the confirmed share of resolved reports (confirmed /
 * resolved-share, 0 when no reports have been resolved yet). `trusted` is a
 * computed badge (not a manual override) once the reporter clears both a
 * confirmed-report volume and an accuracy floor. `spamFlaggedAt` is set when
 * too many of the reporter's reports were rejected within a rolling window
 * and cleared once the recent-rejected count drops back below the
 * threshold; the transition into a spam flag raises an AUTO-3 style alert
 * (see `raiseBanSyncFailureAlert` in apps/workers/ban-sync/src/alerts.ts for
 * the pattern this mirrors).
 */
export const reporterStats = pgTable(
  'reporter_stats',
  {
    playerId: uuid('player_id')
      .primaryKey()
      .notNull()
      .references(() => players.id, { onDelete: 'cascade' }),
    totalReports: integer('total_reports').notNull().default(0),
    resolvedReports: integer('resolved_reports').notNull().default(0),
    rejectedReports: integer('rejected_reports').notNull().default(0),
    confirmedReports: integer('confirmed_reports').notNull().default(0),
    accuracy: real('accuracy').notNull().default(0),
    trusted: boolean('trusted').notNull().default(false),
    spamFlaggedAt: timestamp('spam_flagged_at', { withTimezone: true, mode: 'date' }),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
  },
  (table) => ({
    trustedIdx: index('reporter_stats_trusted_idx').on(table.trusted),
    spamFlaggedIdx: index('reporter_stats_spam_idx').on(table.spamFlaggedAt),
  }),
);

export type ReporterStatsRow = typeof reporterStats.$inferSelect;
export type NewReporterStats = typeof reporterStats.$inferInsert;
