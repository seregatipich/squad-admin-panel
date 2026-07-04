import { sql } from 'drizzle-orm';
import { check, date, index, integer, pgTable, primaryKey, uuid } from 'drizzle-orm/pg-core';
import { players } from './players.js';
import { servers } from './servers.js';

export const playerDailyPresence = pgTable(
  'player_daily_presence',
  {
    playerId: uuid('player_id')
      .notNull()
      .references(() => players.id, { onDelete: 'cascade' }),
    day: date('day', { mode: 'string' }).notNull(),
    serverId: uuid('server_id')
      .notNull()
      .references(() => servers.id, { onDelete: 'cascade' }),
    onlineSeconds: integer('online_seconds').notNull().default(0),
    boostSeconds: integer('boost_seconds').notNull().default(0),
    queueSeconds: integer('queue_seconds').notNull().default(0),
    sessionCount: integer('session_count').notNull().default(0),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.playerId, table.day, table.serverId] }),
    dayIdx: index('player_daily_presence_day_idx').on(table.day),
    secondsChk: check(
      'player_daily_presence_seconds_chk',
      sql`online_seconds >= 0 AND boost_seconds >= 0 AND queue_seconds >= 0 AND session_count >= 0`,
    ),
  }),
);

export type PlayerDailyPresenceRow = typeof playerDailyPresence.$inferSelect;
export type NewPlayerDailyPresence = typeof playerDailyPresence.$inferInsert;
