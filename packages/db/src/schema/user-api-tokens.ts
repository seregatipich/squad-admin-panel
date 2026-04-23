import { pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { users } from './users.js';

export const userApiTokens = pgTable('user_api_tokens', {
  id: uuid('id').primaryKey().notNull(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  tokenHash: text('token_hash').notNull(),
  scopes: text('scopes').array().notNull().default([]),
  lastUsedAt: timestamp('last_used_at', { withTimezone: true, mode: 'date' }),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
  revokedAt: timestamp('revoked_at', { withTimezone: true, mode: 'date' }),
});

export type UserApiTokenRow = typeof userApiTokens.$inferSelect;
export type NewUserApiToken = typeof userApiTokens.$inferInsert;
