import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  date,
  index,
  integer,
  pgTable,
  primaryKey,
  uuid,
} from 'drizzle-orm/pg-core';
import { players } from './players.js';
import { servers } from './servers.js';

/**
 * Co-play graph (ALT-3): per (pair, server, UTC day) rollup of how long two
 * players were connected to the same server at the same time.
 *
 * Rows are stored once per unordered pair with the canonical ordering
 * `player_a_id < player_b_id` (enforced by a CHECK), so a lookup from either
 * side of the pair reads the same aggregate. `window_start` is the UTC day the
 * overlap is attributed to; the rolling 90-day co-play window is applied at read
 * time by summing the last 90 daily buckets. Keeping one row per day makes the
 * nightly incremental recompute (yesterday only) reconcile exactly with a full
 * window rebuild — the sum of daily increments equals a single-pass recompute.
 */
export const playerCoplay = pgTable(
  'player_coplay',
  {
    playerAId: uuid('player_a_id')
      .notNull()
      .references(() => players.id, { onDelete: 'cascade' }),
    playerBId: uuid('player_b_id')
      .notNull()
      .references(() => players.id, { onDelete: 'cascade' }),
    serverId: uuid('server_id')
      .notNull()
      .references(() => servers.id, { onDelete: 'cascade' }),
    windowStart: date('window_start', { mode: 'string' }).notNull(),
    overlapSeconds: bigint('overlap_seconds', { mode: 'number' }).notNull().default(0),
    sharedSessionCount: integer('shared_session_count').notNull().default(0),
  },
  (table) => ({
    pk: primaryKey({
      columns: [table.playerAId, table.playerBId, table.serverId, table.windowStart],
    }),
    playerAIdx: index('player_coplay_player_a_idx').on(table.playerAId, table.windowStart),
    playerBIdx: index('player_coplay_player_b_idx').on(table.playerBId, table.windowStart),
    orderChk: check('player_coplay_order_chk', sql`player_a_id < player_b_id`),
    nonnegChk: check(
      'player_coplay_nonneg_chk',
      sql`overlap_seconds >= 0 AND shared_session_count >= 0`,
    ),
  }),
);

export type PlayerCoplayRow = typeof playerCoplay.$inferSelect;
export type NewPlayerCoplay = typeof playerCoplay.$inferInsert;
