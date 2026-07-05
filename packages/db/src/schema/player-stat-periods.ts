import { sql } from 'drizzle-orm';
import {
  check,
  date,
  index,
  integer,
  numeric,
  pgTable,
  text,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { players } from './players.js';
import { servers } from './servers.js';

export const STAT_PERIOD_TYPES = ['day', 'week', 'month', 'season', 'alltime'] as const;
export type StatPeriodType = (typeof STAT_PERIOD_TYPES)[number];

export const playerStatPeriods = pgTable(
  'player_stat_periods',
  {
    playerId: uuid('player_id')
      .notNull()
      .references(() => players.id, { onDelete: 'cascade' }),
    serverId: uuid('server_id').references(() => servers.id, { onDelete: 'cascade' }),
    periodType: text('period_type').notNull(),
    periodStart: date('period_start', { mode: 'string' }).notNull(),
    onlineSeconds: integer('online_seconds').notNull().default(0),
    seedingSeconds: integer('seeding_seconds').notNull().default(0),
    kills: integer('kills').notNull().default(0),
    deaths: integer('deaths').notNull().default(0),
    teamkills: integer('teamkills').notNull().default(0),
    revives: integer('revives').notNull().default(0),
    kdRatio: numeric('kd_ratio', { mode: 'number' }).notNull().default(0),
    matchesPlayed: integer('matches_played').notNull().default(0),
  },
  (table) => ({
    identity: unique('player_stat_periods_identity')
      .on(table.playerId, table.serverId, table.periodType, table.periodStart)
      .nullsNotDistinct(),
    onlineIdx: index('player_stat_periods_online_idx').on(
      table.periodType,
      table.periodStart,
      table.serverId,
      table.onlineSeconds.desc(),
    ),
    seedingIdx: index('player_stat_periods_seeding_idx').on(
      table.periodType,
      table.periodStart,
      table.serverId,
      table.seedingSeconds.desc(),
    ),
    killsIdx: index('player_stat_periods_kills_idx').on(
      table.periodType,
      table.periodStart,
      table.serverId,
      table.kills.desc(),
    ),
    deathsIdx: index('player_stat_periods_deaths_idx').on(
      table.periodType,
      table.periodStart,
      table.serverId,
      table.deaths.desc(),
    ),
    teamkillsIdx: index('player_stat_periods_teamkills_idx').on(
      table.periodType,
      table.periodStart,
      table.serverId,
      table.teamkills.desc(),
    ),
    revivesIdx: index('player_stat_periods_revives_idx').on(
      table.periodType,
      table.periodStart,
      table.serverId,
      table.revives.desc(),
    ),
    kdIdx: index('player_stat_periods_kd_idx').on(
      table.periodType,
      table.periodStart,
      table.serverId,
      table.kdRatio.desc(),
    ),
    matchesIdx: index('player_stat_periods_matches_idx').on(
      table.periodType,
      table.periodStart,
      table.serverId,
      table.matchesPlayed.desc(),
    ),
    periodTypeChk: check(
      'player_stat_periods_period_type_chk',
      sql`period_type IN ('day','week','month','season','alltime')`,
    ),
    metricsChk: check(
      'player_stat_periods_metrics_chk',
      sql`online_seconds >= 0 AND seeding_seconds >= 0 AND kills >= 0 AND deaths >= 0 AND teamkills >= 0 AND revives >= 0 AND matches_played >= 0 AND kd_ratio >= 0`,
    ),
  }),
);

export type PlayerStatPeriodRow = typeof playerStatPeriods.$inferSelect;
export type NewPlayerStatPeriod = typeof playerStatPeriods.$inferInsert;
