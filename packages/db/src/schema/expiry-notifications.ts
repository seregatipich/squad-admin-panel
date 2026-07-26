import { sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { alertEvents } from './alert-rules.js';
import { players } from './players.js';

/**
 * The seeded, immutable `role_expiring` system alert rule (VIPSUB-4, #170).
 * The role-expirer reminder tick attributes its broadcast `alert_events` rows
 * to this rule; the API rejects PUT/DELETE on it with 409
 * `system_rule_immutable`.
 */
export const ROLE_EXPIRY_ALERT_RULE_ID = '00000000-0000-7000-8000-000000000170';

export const EXPIRY_NOTIFICATION_RECIPIENTS = ['admin', 'player'] as const;
export type ExpiryNotificationRecipient = (typeof EXPIRY_NOTIFICATION_RECIPIENTS)[number];

/**
 * Dedup ledger for VIP expiry reminders (VIPSUB-4, #170). One row per
 * (player, role, expires_at, window, recipient): the `admin` row claims the
 * panel alert broadcast, the `player` row queues the one-shot in-game
 * AdminWarn that log-ingest sends on the player's next connect (`queued_at`
 * stamps delivery). Because `expires_at` is part of the unique key, renewing
 * a grant re-arms every window mechanically — no delete path required.
 * `role_id` deliberately carries NO foreign key: it is a historical reference
 * and must never block role deletion.
 */
export const expiryNotifications = pgTable(
  'expiry_notifications',
  {
    id: uuid('id').primaryKey().notNull().default(sql`gen_random_uuid()`),
    playerId: uuid('player_id')
      .notNull()
      .references(() => players.id, { onDelete: 'cascade' }),
    roleId: uuid('role_id').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }).notNull(),
    windowDays: integer('window_days').notNull(),
    recipient: text('recipient').notNull(),
    alertEventId: uuid('alert_event_id').references(() => alertEvents.id, {
      onDelete: 'set null',
    }),
    queuedAt: timestamp('queued_at', { withTimezone: true, mode: 'date' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
  },
  (table) => ({
    assignmentWindowRecipientKey: uniqueIndex(
      'expiry_notifications_assignment_window_recipient_key',
    ).on(table.playerId, table.roleId, table.expiresAt, table.windowDays, table.recipient),
    pendingPlayerIdx: index('expiry_notifications_pending_player_idx')
      .on(table.playerId)
      .where(sql`recipient = 'player' AND queued_at IS NULL`),
    recipientChk: check(
      'expiry_notifications_recipient_chk',
      sql`${table.recipient} IN ('admin','player')`,
    ),
    windowDaysChk: check(
      'expiry_notifications_window_days_chk',
      sql`${table.windowDays} >= 1 AND ${table.windowDays} <= 90`,
    ),
  }),
);

export type ExpiryNotificationRow = typeof expiryNotifications.$inferSelect;
export type NewExpiryNotification = typeof expiryNotifications.$inferInsert;
