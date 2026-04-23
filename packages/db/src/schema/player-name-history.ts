import {
  bigint,
  bigserial,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { players } from './players.js';

export const playerNameHistory = pgTable(
  'player_name_history',
  {
    id: bigserial('id', { mode: 'bigint' }).primaryKey(),
    steamId64: bigint('steam_id64', { mode: 'bigint' })
      .notNull()
      .references(() => players.steamId64, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    nameNormalized: text('name_normalized').notNull(),
    firstSeenAt: timestamp('first_seen_at', { withTimezone: true, mode: 'date' })
      .defaultNow()
      .notNull(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true, mode: 'date' })
      .defaultNow()
      .notNull(),
    observationCount: integer('observation_count').notNull().default(1),
  },
  (table) => ({
    steamNameKey: uniqueIndex('player_name_history_steam_name_key').on(
      table.steamId64,
      table.nameNormalized,
    ),
    nameNormalizedIdx: index('player_name_history_name_normalized_idx').on(table.nameNormalized),
    lastSeenAtIdx: index('player_name_history_last_seen_at_idx').on(table.lastSeenAt),
  }),
);

export type PlayerNameHistoryRow = typeof playerNameHistory.$inferSelect;
export type NewPlayerNameHistory = typeof playerNameHistory.$inferInsert;
