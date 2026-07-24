import { sql } from 'drizzle-orm';
import { boolean, check, index, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { players } from './players.js';
import { servers } from './servers.js';

/** Trigger condition kinds an automation rule can evaluate (AUTO-1, #72). */
export const AUTOMATION_CONDITION_TYPES = [
  'chat_keyword',
  'player_count',
  'time_of_day',
  'player_flag',
] as const;
export type AutomationConditionType = (typeof AUTOMATION_CONDITION_TYPES)[number];

/** Action kinds an automation rule can perform when its condition matches. */
export const AUTOMATION_ACTION_TYPES = ['rcon_command', 'kick', 'warn', 'notify_admin'] as const;
export type AutomationActionType = (typeof AUTOMATION_ACTION_TYPES)[number];

/** Outcome recorded for a single rule evaluation/firing in `automation_runs`. */
export const AUTOMATION_RUN_STATUSES = [
  'matched',
  'no_match',
  'executed',
  'failed',
  'skipped',
] as const;
export type AutomationRunStatus = (typeof AUTOMATION_RUN_STATUSES)[number];

/**
 * automation_rules (AUTO-1, #72): user-defined "if {condition} → {action}"
 * trigger engine. A row pairs one {@link AUTOMATION_CONDITION_TYPES} condition
 * (its parameters in `condition` jsonb) with one {@link AUTOMATION_ACTION_TYPES}
 * action (`action` jsonb). Event-driven conditions (`player_count`,
 * `time_of_day`, `player_flag`) are evaluated by `@squad/worker-automation`
 * over the Redis event streams; `chat_keyword` is evaluated inline in
 * `@squad/worker-log-ingest`'s chat path. Every firing writes an
 * {@link automationRuns} row and an `audit_log` entry.
 *
 * `server_id` scopes a rule to one server; a null `server_id` is a global rule
 * that applies to every server's events. Rules are managed via
 * `/api/v1/automation-rules`, which mirrors the AUTO-3 alert-rules route.
 */
export const automationRules = pgTable(
  'automation_rules',
  {
    id: uuid('id').primaryKey().notNull().default(sql`gen_random_uuid()`),
    serverId: uuid('server_id').references(() => servers.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    conditionType: text('condition_type').$type<AutomationConditionType>().notNull(),
    condition: jsonb('condition').notNull().default({}),
    actionType: text('action_type').$type<AutomationActionType>().notNull(),
    action: jsonb('action').notNull().default({}),
    enabled: boolean('enabled').notNull().default(true),
    createdBy: uuid('created_by').references(() => players.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
  },
  (table) => ({
    conditionTypeChk: check(
      'automation_rules_condition_type_chk',
      sql`${table.conditionType} IN ('chat_keyword','player_count','time_of_day','player_flag')`,
    ),
    actionTypeChk: check(
      'automation_rules_action_type_chk',
      sql`${table.actionType} IN ('rcon_command','kick','warn','notify_admin')`,
    ),
    enabledIdx: index('automation_rules_enabled_idx').on(table.enabled),
    serverIdx: index('automation_rules_server_idx').on(table.serverId),
  }),
);

/**
 * automation_runs (AUTO-1, #72): append-only firing history for
 * {@link automationRules}. One row per evaluation that matched — whether a real
 * firing (`status` `executed`/`failed`/`skipped`, `dry_run=false`) or a
 * dry-run test (`status` `matched`/`no_match`, `dry_run=true`). `matched`
 * snapshots the trigger data that satisfied the condition; `action_result`
 * carries the executed command / delivery outcome (or a `{ skipped: true }`
 * preview for a dry-run). `server_id` is the server the triggering event came
 * from (may differ from a global rule's null `server_id`).
 */
export const automationRuns = pgTable(
  'automation_runs',
  {
    id: uuid('id').primaryKey().notNull().default(sql`gen_random_uuid()`),
    ruleId: uuid('rule_id')
      .notNull()
      .references(() => automationRules.id, { onDelete: 'cascade' }),
    serverId: uuid('server_id'),
    firedAt: timestamp('fired_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
    matched: jsonb('matched').notNull().default({}),
    actionResult: jsonb('action_result'),
    dryRun: boolean('dry_run').notNull().default(false),
    status: text('status').$type<AutomationRunStatus>().notNull(),
  },
  (table) => ({
    statusChk: check(
      'automation_runs_status_chk',
      sql`${table.status} IN ('matched','no_match','executed','failed','skipped')`,
    ),
    ruleFiredIdx: index('automation_runs_rule_fired_idx').on(table.ruleId, table.firedAt.desc()),
    firedIdx: index('automation_runs_fired_idx').on(table.firedAt.desc()),
  }),
);

export type AutomationRuleRow = typeof automationRules.$inferSelect;
export type NewAutomationRule = typeof automationRules.$inferInsert;
export type AutomationRunRow = typeof automationRuns.$inferSelect;
export type NewAutomationRun = typeof automationRuns.$inferInsert;
