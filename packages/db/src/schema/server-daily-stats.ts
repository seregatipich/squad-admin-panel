import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { servers } from './servers.js';

/**
 * Materialised per-server, per-UTC-day rollup backing the `/statistics`
 * dashboard (LEAD-5, #176). Reading the dashboard must never live-scan
 * `events`/`combat_events`, so every daily scalar the page plots is
 * precomputed here.
 *
 * The table has exactly one writer — `recomputeServerDailyStats()`, driven by
 * the hourly `presence-daily` worker over the yesterday+today window. Anything
 * that needs sub-day resolution (online-by-hour-of-day) is computed live in the
 * API from `player_sessions`; anything that is a pure regrouping of days
 * (online-by-weekday) is derived from these rows.
 *
 * `modes` and `maps` are `{key: count}` objects. `maps` deliberately excludes
 * seed rounds (`matches.is_seed`) and Skirmish, which are not "combat" layers;
 * `modes` keeps them so the mode doughnut stays complete. `matches` counts
 * every round of the day, seed and skirmish included.
 */
export const serverDailyStats = pgTable(
  'server_daily_stats',
  {
    serverId: uuid('server_id')
      .notNull()
      .references(() => servers.id, { onDelete: 'cascade' }),
    day: date('day', { mode: 'string' }).notNull(),
    /** Time-weighted mean concurrent online players over the elapsed part of the day. */
    avgOnline: integer('avg_online').notNull().default(0),
    /** Exact maximum of concurrent online sessions, from an interval sweep. */
    peakOnline: integer('peak_online').notNull().default(0),
    /** Time-weighted mean concurrent players in the queue over the elapsed part of the day. */
    avgQueue: integer('avg_queue').notNull().default(0),
    onlineSeconds: bigint('online_seconds', { mode: 'number' }).notNull().default(0),
    matches: integer('matches').notNull().default(0),
    modes: jsonb('modes').notNull().default({}),
    maps: jsonb('maps').notNull().default({}),
    newPlayers: integer('new_players').notNull().default(0),
    chatMessages: integer('chat_messages').notNull().default(0),
    teamkills: integer('teamkills').notNull().default(0),
    punishments: integer('punishments').notNull().default(0),
    avgAdmins: integer('avg_admins').notNull().default(0),
    peakAdmins: integer('peak_admins').notNull().default(0),
    computedAt: timestamp('computed_at', { withTimezone: true, mode: 'date' })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.serverId, table.day] }),
    dayIdx: index('server_daily_stats_day_idx').on(table.day),
    nonNegChk: check(
      'server_daily_stats_nonneg_chk',
      sql`avg_online >= 0 AND peak_online >= 0 AND avg_queue >= 0 AND online_seconds >= 0
        AND matches >= 0 AND new_players >= 0 AND chat_messages >= 0 AND teamkills >= 0
        AND punishments >= 0 AND avg_admins >= 0 AND peak_admins >= 0`,
    ),
  }),
);

export type ServerDailyStatsRow = typeof serverDailyStats.$inferSelect;
export type NewServerDailyStats = typeof serverDailyStats.$inferInsert;
