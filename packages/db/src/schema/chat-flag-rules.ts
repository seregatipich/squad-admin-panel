import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { players } from './players.js';

export const chatFlagRules = pgTable(
  'chat_flag_rules',
  {
    id: uuid('id').primaryKey().notNull().default(sql`gen_random_uuid()`),
    pattern: text('pattern').notNull(),
    patternType: text('pattern_type').notNull().default('word'),
    locale: text('locale').notNull().default('all'),
    enabled: boolean('enabled').notNull().default(true),
    createdBy: uuid('created_by').references(() => players.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
  },
  (table) => ({
    patternKey: uniqueIndex('chat_flag_rules_pattern_key').on(
      table.pattern,
      table.patternType,
      table.locale,
    ),
    enabledIdx: index('chat_flag_rules_enabled_idx').on(table.enabled, table.createdAt),
    patternTypeChk: check(
      'chat_flag_rules_pattern_type_chk',
      sql`pattern_type IN ('word','regex')`,
    ),
  }),
);

export type ChatFlagRuleRow = typeof chatFlagRules.$inferSelect;
export type NewChatFlagRule = typeof chatFlagRules.$inferInsert;
