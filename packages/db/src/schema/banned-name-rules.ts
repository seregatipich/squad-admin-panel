import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { players } from './players.js';

export const bannedNameRules = pgTable(
  'banned_name_rules',
  {
    id: uuid('id').primaryKey().notNull().default(sql`gen_random_uuid()`),
    pattern: text('pattern').notNull(),
    matchType: text('match_type').notNull().default('exact'),
    reason: text('reason'),
    action: text('action').notNull().default('kick'),
    isActive: boolean('is_active').notNull().default(true),
    createdBy: uuid('created_by').references(() => players.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
    hitCount: integer('hit_count').notNull().default(0),
    lastHitAt: timestamp('last_hit_at', { withTimezone: true, mode: 'date' }),
  },
  (table) => ({
    patternMatchTypeKey: uniqueIndex('banned_name_rules_pattern_match_type_key').on(
      table.pattern,
      table.matchType,
    ),
    matchTypeCheck: check(
      'banned_name_rules_match_type_enum',
      sql`match_type IN ('exact','substring','regex')`,
    ),
    actionCheck: check('banned_name_rules_action_enum', sql`action IN ('kick','alert')`),
  }),
);

export type BannedNameRuleRow = typeof bannedNameRules.$inferSelect;
export type NewBannedNameRule = typeof bannedNameRules.$inferInsert;
