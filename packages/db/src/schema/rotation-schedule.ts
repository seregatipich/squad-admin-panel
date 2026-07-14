import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  pgTable,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { players } from './players.js';
import { servers } from './servers.js';

/** RCON operation used when a scheduled rotation change becomes due. */
export const ROTATION_SCHEDULE_MODES = ['set_next', 'force_change'] as const;
export type RotationScheduleMode = (typeof ROTATION_SCHEDULE_MODES)[number];

/** A one-off layer change planned on the server rotation calendar. */
export const rotationSchedule = pgTable(
  'rotation_schedule',
  {
    id: uuid('id').primaryKey().notNull().defaultRandom(),
    serverId: uuid('server_id')
      .notNull()
      .references(() => servers.id, { onDelete: 'cascade' }),
    scheduledAt: timestamp('scheduled_at', { withTimezone: true, mode: 'date' }).notNull(),
    layer: text('layer').notNull(),
    mode: text('mode').$type<RotationScheduleMode>().notNull().default('set_next'),
    createdBy: uuid('created_by').references(() => players.id, { onDelete: 'set null' }),
    enabled: boolean('enabled').notNull().default(true),
    lastExecutedAt: timestamp('last_executed_at', { withTimezone: true, mode: 'date' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
  },
  (table) => ({
    serverScheduledIdx: index('rotation_schedule_server_scheduled_idx').on(
      table.serverId,
      table.scheduledAt,
    ),
    modeCheck: check('rotation_schedule_mode_check', sql`mode IN ('set_next','force_change')`),
  }),
);

export type RotationScheduleRow = typeof rotationSchedule.$inferSelect;
export type NewRotationSchedule = typeof rotationSchedule.$inferInsert;

/**
 * Named managed-segment variants. `weekday` is UTC-independent server-local
 * weekday 0..6 (Sunday..Saturday); null is the default profile.
 */
export const rotationProfiles = pgTable(
  'rotation_profiles',
  {
    id: uuid('id').primaryKey().notNull().defaultRandom(),
    serverId: uuid('server_id')
      .notNull()
      .references(() => servers.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    weekday: smallint('weekday'),
    layers: text('layers').array().notNull().default([]),
    createdBy: uuid('created_by').references(() => players.id, { onDelete: 'set null' }),
    lastAppliedAt: timestamp('last_applied_at', { withTimezone: true, mode: 'date' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
  },
  (table) => ({
    serverWeekdayIdx: index('rotation_profiles_server_weekday_idx').on(
      table.serverId,
      table.weekday,
    ),
    serverDefaultKey: uniqueIndex('rotation_profiles_server_default_key')
      .on(table.serverId)
      .where(sql`weekday IS NULL`),
    serverWeekdayKey: uniqueIndex('rotation_profiles_server_weekday_key')
      .on(table.serverId, table.weekday)
      .where(sql`weekday IS NOT NULL`),
    weekdayCheck: check(
      'rotation_profiles_weekday_check',
      sql`weekday IS NULL OR (weekday >= 0 AND weekday <= 6)`,
    ),
  }),
);

export type RotationProfileRow = typeof rotationProfiles.$inferSelect;
export type NewRotationProfile = typeof rotationProfiles.$inferInsert;
