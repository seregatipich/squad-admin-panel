import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

/**
 * Named leaderboard seasons (LEAD-7, issue #178).
 *
 * A season is an arbitrary named interval, not a calendar year: the
 * leaderboard aggregator materialises `player_stat_periods` rows with
 * `period_type = 'season'` and `period_start = starts_at::date` over the
 * explicit `[starts_at, ends_at]` window of the single `active` season.
 *
 * Invariants enforced here rather than in application code:
 * - `seasons_one_active` — a partial unique index over a constant, so at most
 *   one row may hold `status = 'active'` at any time. This is what lets the
 *   aggregator resolve "the" active season with a bare `LIMIT 1`.
 * - `seasons_bounds_chk` — a season must cover a non-empty interval.
 * - `seasons_status_chk` — the lifecycle is `upcoming -> active -> closed`.
 *
 * `finalized` freezes a season: once set, the aggregator skips it, so the
 * materialised rows never change again.
 */
export const seasons = pgTable(
  'seasons',
  {
    id: uuid('id').primaryKey().notNull(),
    name: text('name').notNull(),
    startsAt: timestamp('starts_at', { withTimezone: true, mode: 'date' }).notNull(),
    endsAt: timestamp('ends_at', { withTimezone: true, mode: 'date' }).notNull(),
    status: text('status').notNull().default('upcoming'),
    finalized: boolean('finalized').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
  },
  (table) => ({
    nameKey: uniqueIndex('seasons_name_key').on(table.name),
    oneActiveIdx: uniqueIndex('seasons_one_active').on(sql`(status)`).where(sql`status = 'active'`),
    statusIdx: index('seasons_status_idx').on(table.status, table.startsAt),
    boundsCheck: check('seasons_bounds_chk', sql`ends_at > starts_at`),
    statusCheck: check('seasons_status_chk', sql`status IN ('upcoming', 'active', 'closed')`),
  }),
);

export const SEASON_STATUSES = ['upcoming', 'active', 'closed'] as const;
export type SeasonStatus = (typeof SEASON_STATUSES)[number];

export type SeasonRow = typeof seasons.$inferSelect;
export type NewSeason = typeof seasons.$inferInsert;
