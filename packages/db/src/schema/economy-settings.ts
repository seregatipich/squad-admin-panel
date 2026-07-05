import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  doublePrecision,
  integer,
  jsonb,
  pgTable,
  smallint,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { players } from './players.js';

export interface PrivilegeCost {
  days: number;
  price: number;
}

export type PrivilegeCostCatalog = Record<string, PrivilegeCost>;

export const economySettings = pgTable(
  'economy_settings',
  {
    id: smallint('id').primaryKey().default(1),
    kOnline: doublePrecision('k_online').notNull().default(1),
    kBoost: doublePrecision('k_boost').notNull().default(2),
    kSeed: doublePrecision('k_seed').notNull().default(3),
    seedThreshold: integer('seed_threshold').notNull().default(40),
    economyEnabled: boolean('economy_enabled').notNull().default(false),
    privilegeCosts: jsonb('privilege_costs').notNull().default({}).$type<PrivilegeCostCatalog>(),
    updatedByPlayerId: uuid('updated_by_player_id').references(() => players.id, {
      onDelete: 'set null',
    }),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
  },
  (table) => ({
    singleton: check('economy_settings_singleton', sql`${table.id} = 1`),
    kOnlineNonneg: check('economy_settings_k_online_nonneg', sql`${table.kOnline} >= 0`),
    kBoostNonneg: check('economy_settings_k_boost_nonneg', sql`${table.kBoost} >= 0`),
    kSeedNonneg: check('economy_settings_k_seed_nonneg', sql`${table.kSeed} >= 0`),
    seedThresholdRange: check(
      'economy_settings_seed_threshold_range',
      sql`${table.seedThreshold} >= 0 AND ${table.seedThreshold} <= 100`,
    ),
  }),
);

export type EconomySettingsRow = typeof economySettings.$inferSelect;
export type NewEconomySettings = typeof economySettings.$inferInsert;
