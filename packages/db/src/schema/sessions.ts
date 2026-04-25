import { bigint, index, inet, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import { players } from './players.js';

export const sessions = pgTable(
  'sessions',
  {
    id: text('id').primaryKey().notNull(),
    steamId64: bigint('steam_id64', { mode: 'bigint' })
      .notNull()
      .references(() => players.steamId64, { onDelete: 'cascade' }),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }).notNull(),
    lastActivityAt: timestamp('last_activity_at', { withTimezone: true, mode: 'date' })
      .defaultNow()
      .notNull(),
    ip: inet('ip'),
    userAgent: text('user_agent'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
  },
  (table) => ({
    steamIdIdx: index('sessions_steam_id64_idx').on(table.steamId64),
    expiresAtIdx: index('sessions_expires_at_idx').on(table.expiresAt),
    lastActivityIdx: index('sessions_last_activity_idx').on(table.lastActivityAt),
  }),
);

export type SessionRow = typeof sessions.$inferSelect;
export type NewSession = typeof sessions.$inferInsert;
