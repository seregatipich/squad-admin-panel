import { sql } from 'drizzle-orm';
import { boolean, check, index, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { players } from './players.js';

export const alertRules = pgTable(
  'alert_rules',
  {
    id: uuid('id').primaryKey().notNull().default(sql`gen_random_uuid()`),
    name: text('name').notNull(),
    type: text('type').notNull(),
    config: jsonb('config').notNull().default({}),
    channels: jsonb('channels').notNull().default([]),
    enabled: boolean('enabled').notNull().default(true),
    createdBy: uuid('created_by').references(() => players.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
  },
  (table) => ({
    typeChk: check(
      'alert_rules_type_chk',
      sql`${table.type} IN ('server_crashed','unusual_activity','admin_login_new_ip','custom')`,
    ),
    enabledIdx: index('alert_rules_enabled_idx').on(table.enabled),
  }),
);

export const alertEvents = pgTable(
  'alert_events',
  {
    id: uuid('id').primaryKey().notNull().default(sql`gen_random_uuid()`),
    ruleId: uuid('rule_id')
      .notNull()
      .references(() => alertRules.id, { onDelete: 'cascade' }),
    triggeredAt: timestamp('triggered_at', { withTimezone: true, mode: 'date' })
      .defaultNow()
      .notNull(),
    payload: jsonb('payload').notNull().default({}),
    severity: text('severity').notNull().default('warning'),
    delivered: boolean('delivered').notNull().default(false),
  },
  (table) => ({
    severityChk: check(
      'alert_events_severity_chk',
      sql`${table.severity} IN ('info','warning','critical')`,
    ),
    ruleTriggeredIdx: index('alert_events_rule_triggered_idx').on(
      table.ruleId,
      table.triggeredAt.desc(),
    ),
    triggeredIdx: index('alert_events_triggered_idx').on(table.triggeredAt.desc()),
  }),
);

export type AlertRuleRow = typeof alertRules.$inferSelect;
export type NewAlertRule = typeof alertRules.$inferInsert;
export type AlertEventRow = typeof alertEvents.$inferSelect;
export type NewAlertEvent = typeof alertEvents.$inferInsert;
