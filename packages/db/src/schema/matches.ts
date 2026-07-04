import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { servers } from './servers.js';

export const matches = pgTable(
  'matches',
  {
    id: uuid('id').primaryKey().notNull().default(sql`gen_random_uuid()`),
    serverId: uuid('server_id')
      .notNull()
      .references(() => servers.id, { onDelete: 'cascade' }),
    layer: text('layer'),
    map: text('map'),
    gameMode: text('game_mode'),
    team1Faction: text('team1_faction'),
    team2Faction: text('team2_faction'),
    team1Tickets: integer('team1_tickets'),
    team2Tickets: integer('team2_tickets'),
    winner: text('winner'),
    isSeed: boolean('is_seed').notNull().default(false),
    startedAt: timestamp('started_at', { withTimezone: true, mode: 'date' }).notNull(),
    endedAt: timestamp('ended_at', { withTimezone: true, mode: 'date' }),
    durationSeconds: integer('duration_seconds'),
    endReason: text('end_reason'),
  },
  (table) => ({
    serverStartedKey: uniqueIndex('matches_server_started_key').on(table.serverId, table.startedAt),
    serverStartedIdx: index('matches_server_started_idx').on(
      table.serverId,
      table.startedAt.desc(),
    ),
    startedIdx: index('matches_started_idx').on(table.startedAt.desc()),
    layerIdx: index('matches_layer_idx').on(table.layer),
    openIdx: index('matches_open_idx')
      .on(table.serverId, table.startedAt.desc())
      .where(sql`ended_at IS NULL`),
    winnerCheck: check('matches_winner_enum', sql`winner IN ('team1','team2','draw')`),
    endReasonCheck: check(
      'matches_end_reason_enum',
      sql`end_reason IN ('ended','server_crashed','server_restarted')`,
    ),
  }),
);

export type MatchRow = typeof matches.$inferSelect;
export type NewMatch = typeof matches.$inferInsert;
