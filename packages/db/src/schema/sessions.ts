import { sql } from 'drizzle-orm';
import { check, index, inet, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { players } from './players.js';

/**
 * Authority a session carries (VIPSUB-5, #171).
 *
 * `panel` is the historical behaviour: the session is honoured everywhere and
 * authorisation is decided per route. `self_service` is minted for a Steam
 * login whose role has no `panel_access`; it identifies the player but is only
 * honoured on routes that opt in with `config.selfService`, so widening
 * session minting cannot expose any pre-existing route.
 */
export const SESSION_SCOPES = ['panel', 'self_service'] as const;
export type SessionScope = (typeof SESSION_SCOPES)[number];

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
    scope: text('scope').notNull().default('panel'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
  },
  (table) => ({
    playerIdIdx: index('sessions_player_id_idx').on(table.playerId),
    expiresAtIdx: index('sessions_expires_at_idx').on(table.expiresAt),
    lastActivityIdx: index('sessions_last_activity_idx').on(table.lastActivityAt),
    scopeChk: check('sessions_scope_chk', sql`${table.scope} IN ('panel','self_service')`),
  }),
);

export type SessionRow = typeof sessions.$inferSelect;
export type NewSession = typeof sessions.$inferInsert;
