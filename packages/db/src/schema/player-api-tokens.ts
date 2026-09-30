import { index, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
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
    // Every auth request looks tokens up by tokenHash (apps/api/src/plugins/auth.ts);
    // without this index that lookup is a full table scan, including for
    // well-formed-but-invalid bearer tokens. Hashes are also expected to be
    // unique per minted token (packages/db/src/schema/media-upload-tokens.ts
    // follows the same pattern for its own token hash column).
    tokenHashKey: uniqueIndex('player_api_tokens_token_hash_key').on(table.tokenHash),
  }),
);

export type PlayerApiTokenRow = typeof playerApiTokens.$inferSelect;
export type NewPlayerApiToken = typeof playerApiTokens.$inferInsert;
