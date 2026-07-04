import { sql } from 'drizzle-orm';
import { check, index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { players } from './players.js';
import { servers } from './servers.js';

export const playerReports = pgTable(
  'player_reports',
  {
    id: uuid('id').primaryKey().notNull().default(sql`gen_random_uuid()`),
    serverId: uuid('server_id')
      .notNull()
      .references(() => servers.id, { onDelete: 'cascade' }),
    reporterPlayerId: uuid('reporter_player_id').references(() => players.id, {
      onDelete: 'set null',
    }),
    targetPlayerId: uuid('target_player_id').references(() => players.id, {
      onDelete: 'set null',
    }),
    targetRaw: text('target_raw'),
    body: text('body').notNull(),
    source: text('source').notNull(),
    status: text('status').notNull().default('pending'),
    handlerPlayerId: uuid('handler_player_id').references(() => players.id, {
      onDelete: 'set null',
    }),
    resolutionNote: text('resolution_note'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
    claimedAt: timestamp('claimed_at', { withTimezone: true, mode: 'date' }),
    resolvedAt: timestamp('resolved_at', { withTimezone: true, mode: 'date' }),
  },
  (table) => ({
    statusCreatedIdx: index('player_reports_status_created_idx').on(table.status, table.createdAt),
    targetPlayerIdx: index('player_reports_target_player_idx').on(table.targetPlayerId),
    serverIdx: index('player_reports_server_idx').on(table.serverId),
    sourceCheck: check('player_reports_source_enum', sql`source IN ('ingame','ui')`),
    statusCheck: check(
      'player_reports_status_enum',
      sql`status IN ('pending','in_review','resolved','rejected')`,
    ),
  }),
);

export type PlayerReportRow = typeof playerReports.$inferSelect;
export type NewPlayerReport = typeof playerReports.$inferInsert;
