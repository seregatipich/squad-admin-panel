import {
  bigint,
  bigserial,
  index,
  inet,
  integer,
  pgTable,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { players } from './players.js';

export const playerIpHistory = pgTable(
  'player_ip_history',
  {
    id: bigserial('id', { mode: 'bigint' }).primaryKey(),
    steamId64: bigint('steam_id64', { mode: 'bigint' })
      .notNull()
      .references(() => players.steamId64, { onDelete: 'cascade' }),
    ip: inet('ip').notNull(),
    firstSeenAt: timestamp('first_seen_at', { withTimezone: true, mode: 'date' })
      .defaultNow()
      .notNull(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true, mode: 'date' })
      .defaultNow()
      .notNull(),
    observationCount: integer('observation_count').notNull().default(1),
  },
  (table) => ({
    steamIpKey: uniqueIndex('player_ip_history_steam_ip_key').on(table.steamId64, table.ip),
    ipIdx: index('player_ip_history_ip_idx').on(table.ip),
  }),
);

export type PlayerIpHistoryRow = typeof playerIpHistory.$inferSelect;
export type NewPlayerIpHistory = typeof playerIpHistory.$inferInsert;
