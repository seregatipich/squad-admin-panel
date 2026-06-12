import { index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { players } from './players.js';

export const playerApiTokens = pgTable(
  'player_api_tokens',
  {
    id: uuid('id').primaryKey().notNull(),
    playerId: uuid('player_id')
      .notNull()
      .references(() => players.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    tokenHash: text('token_hash').notNull(),
    scopes: text('scopes').array().notNull().default([]),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true, mode: 'date' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true, mode: 'date' }),
  },
  (table) => ({
    playerIdIdx: index('player_api_tokens_player_id_idx').on(table.playerId),
  }),
);

export type PlayerApiTokenRow = typeof playerApiTokens.$inferSelect;
export type NewPlayerApiToken = typeof playerApiTokens.$inferInsert;
