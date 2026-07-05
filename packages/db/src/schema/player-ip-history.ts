import {
  bigserial,
  doublePrecision,
  index,
  inet,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { players } from './players.js';

export const playerIpHistory = pgTable(
  'player_ip_history',
  {
    id: bigserial('id', { mode: 'bigint' }).primaryKey(),
    playerId: uuid('player_id')
      .notNull()
      .references(() => players.id, { onDelete: 'cascade' }),
    ip: inet('ip').notNull(),
    countryCode: text('country_code'),
    countryName: text('country_name'),
    region: text('region'),
    city: text('city'),
    timezoneOffset: text('timezone_offset'),
    latitude: doublePrecision('latitude'),
    longitude: doublePrecision('longitude'),
    firstSeenAt: timestamp('first_seen_at', { withTimezone: true, mode: 'date' })
      .defaultNow()
      .notNull(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true, mode: 'date' })
      .defaultNow()
      .notNull(),
    observationCount: integer('observation_count').notNull().default(1),
  },
  (table) => ({
    playerIpKey: uniqueIndex('player_ip_history_player_ip_key').on(table.playerId, table.ip),
    ipIdx: index('player_ip_history_ip_idx').on(table.ip),
  }),
);

export type PlayerIpHistoryRow = typeof playerIpHistory.$inferSelect;
export type NewPlayerIpHistory = typeof playerIpHistory.$inferInsert;
