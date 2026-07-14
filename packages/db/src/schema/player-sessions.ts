import { sql } from 'drizzle-orm';
import {
  bigserial,
  check,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { players } from './players.js';
import { servers } from './servers.js';

export const CLOSED_REASONS = ['disconnect', 'server_crashed', 'kicked', 'banned'] as const;
export type ClosedReason = (typeof CLOSED_REASONS)[number];

export const SESSION_MODES = ['online', 'boost', 'queue', 'seed'] as const;
export type SessionMode = (typeof SESSION_MODES)[number];

export const playerSessions = pgTable(
  'player_sessions',
  {
    id: bigserial('id', { mode: 'bigint' }).notNull(),
    playerId: uuid('player_id')
      .notNull()
      .references(() => players.id, { onDelete: 'cascade' }),
    serverId: uuid('server_id')
      .notNull()
      .references(() => servers.id, { onDelete: 'cascade' }),
    connectedAt: timestamp('connected_at', { withTimezone: true, mode: 'date' }).notNull(),
    disconnectedAt: timestamp('disconnected_at', { withTimezone: true, mode: 'date' }),
    durationSeconds: integer('duration_seconds'),
    closedReason: text('closed_reason'),
    mode: text('mode').notNull().default('online'),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.id, table.connectedAt] }),
    playerConnectedIdx: index('player_sessions_player_connected_idx').on(
      table.playerId,
      table.connectedAt,
    ),
    serverConnectedIdx: index('player_sessions_server_connected_idx').on(
      table.serverId,
      table.connectedAt,
    ),
    openIdx: index('player_sessions_open_idx')
      .on(table.serverId, table.playerId)
      .where(sql`disconnected_at IS NULL`),
    connectedAtBrinIdx: index('player_sessions_connected_at_brin_idx')
      .using('brin', table.connectedAt)
      .with({ pages_per_range: 32 }),
    closedReasonChk: check(
      'player_sessions_closed_reason_chk',
      sql`closed_reason IS NULL OR closed_reason IN ('disconnect','server_crashed','kicked','banned')`,
    ),
    modeChk: check('player_sessions_mode_chk', sql`mode IN ('online','boost','queue','seed')`),
  }),
);

export type PlayerSessionRow = typeof playerSessions.$inferSelect;
export type NewPlayerSession = typeof playerSessions.$inferInsert;
