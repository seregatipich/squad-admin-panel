import { index, inet, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { players } from './players.js';

export const sessions = pgTable(
  'sessions',
  {
    id: text('id').primaryKey().notNull(),
    playerId: uuid('player_id')
      .notNull()
      .references(() => players.id, { onDelete: 'cascade' }),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }).notNull(),
    lastActivityAt: timestamp('last_activity_at', { withTimezone: true, mode: 'date' })
      .defaultNow()
      .notNull(),
    ip: inet('ip'),
    userAgent: text('user_agent'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
  },
  (table) => ({
    playerIdIdx: index('sessions_player_id_idx').on(table.playerId),
    expiresAtIdx: index('sessions_expires_at_idx').on(table.expiresAt),
    lastActivityIdx: index('sessions_last_activity_idx').on(table.lastActivityAt),
  }),
);

export type SessionRow = typeof sessions.$inferSelect;
export type NewSession = typeof sessions.$inferInsert;
