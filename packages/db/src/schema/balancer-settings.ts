import { sql } from 'drizzle-orm';
import { boolean, check, integer, pgTable, smallint, timestamp, uuid } from 'drizzle-orm/pg-core';
import { players } from './players.js';

/**
 * balancer_settings (GAME-2, #81): the singleton rules row for the team
 * balancer review surface. One row, `id = 1`, modelled on `economy_settings`.
 *
 * The three `*_threshold` columns are the imbalance triggers the panel
 * evaluates against an ingested snapshot's `signals` blob (see
 * `evaluateBalancerSignals` in `@squad/shared-types`). `quorum`,
 * `pass_threshold_pct` and `require_moderator_veto` describe the runtime vote
 * model that SquadJS owns — the panel stores and displays them so operators
 * configure one place, but does not run a vote itself. `prefer_squad_grouping`
 * and `player_level_enabled` control which proposal granularity the review UI
 * offers.
 *
 * Nothing here enables a live team change: #81 is review/configuration only.
 */
export const balancerSettings = pgTable(
  'balancer_settings',
  {
    id: smallint('id').primaryKey().default(1),
    enabled: boolean('enabled').notNull().default(false),
    winStreakThreshold: integer('win_streak_threshold').notNull().default(3),
    ticketDiffThreshold: integer('ticket_diff_threshold').notNull().default(150),
    oneSidedRoundsThreshold: integer('one_sided_rounds_threshold').notNull().default(2),
    quorum: integer('quorum').notNull().default(5),
    passThresholdPct: integer('pass_threshold_pct').notNull().default(60),
    requireModeratorVeto: boolean('require_moderator_veto').notNull().default(false),
    preferSquadGrouping: boolean('prefer_squad_grouping').notNull().default(true),
    playerLevelEnabled: boolean('player_level_enabled').notNull().default(false),
    updatedByPlayerId: uuid('updated_by_player_id').references(() => players.id, {
      onDelete: 'set null',
    }),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
  },
  (table) => ({
    singleton: check('balancer_settings_singleton', sql`${table.id} = 1`),
    winStreakRange: check(
      'balancer_settings_win_streak_threshold_check',
      sql`${table.winStreakThreshold} >= 1`,
    ),
    ticketDiffRange: check(
      'balancer_settings_ticket_diff_threshold_check',
      sql`${table.ticketDiffThreshold} >= 0`,
    ),
    oneSidedRoundsRange: check(
      'balancer_settings_one_sided_rounds_threshold_check',
      sql`${table.oneSidedRoundsThreshold} >= 1`,
    ),
    quorumRange: check('balancer_settings_quorum_check', sql`${table.quorum} >= 0`),
    passThresholdRange: check(
      'balancer_settings_pass_threshold_pct_check',
      sql`${table.passThresholdPct} >= 0 AND ${table.passThresholdPct} <= 100`,
    ),
  }),
);

export type BalancerSettingsRow = typeof balancerSettings.$inferSelect;
export type NewBalancerSettings = typeof balancerSettings.$inferInsert;
