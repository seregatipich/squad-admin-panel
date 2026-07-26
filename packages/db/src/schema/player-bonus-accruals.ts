import { sql } from 'drizzle-orm';
import { check, index, integer, pgTable, timestamp, uuid } from 'drizzle-orm/pg-core';
import { players } from './players.js';

/**
 * ECON-5 (#165): precomputed rolling 30-day bonus accrual window per player.
 * Plain aggregate table (house pattern — not a materialized view), fully
 * rebuilt by the leaderboard-aggregator tick via `recomputeBonusAccruals`.
 * Backs `GET /api/v1/leaderboards/bonuses?period=30d`.
 */
export const playerBonusAccruals = pgTable(
  'player_bonus_accruals',
  {
    playerId: uuid('player_id')
      .primaryKey()
      .notNull()
      .references(() => players.id, { onDelete: 'cascade' }),
    accrued30d: integer('accrued_30d').notNull().default(0),
    computedAt: timestamp('computed_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    accruedIdx: index('player_bonus_accruals_accrued_idx').on(table.accrued30d.desc()),
    nonnegChk: check('player_bonus_accruals_nonneg', sql`accrued_30d >= 0`),
  }),
);

export type PlayerBonusAccrualRow = typeof playerBonusAccruals.$inferSelect;
export type NewPlayerBonusAccrual = typeof playerBonusAccruals.$inferInsert;
