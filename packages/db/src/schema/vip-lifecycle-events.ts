import { sql } from 'drizzle-orm';
import { check, index, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { players } from './players.js';
import { roles } from './roles.js';

export const vipLifecycleEvents = pgTable(
  'vip_lifecycle_events',
  {
    eventId: text('event_id').primaryKey().notNull(),
    eventType: text('event_type').notNull(),
    playerId: uuid('player_id').references(() => players.id, { onDelete: 'set null' }),
    roleId: uuid('role_id').references(() => roles.id, { onDelete: 'set null' }),
    tier: text('tier'),
    purchaseId: text('purchase_id'),
    action: text('action').notNull(),
    payload: jsonb('payload').notNull().default({}),
    receivedAt: timestamp('received_at', { withTimezone: true, mode: 'date' })
      .defaultNow()
      .notNull(),
    appliedAt: timestamp('applied_at', { withTimezone: true, mode: 'date' }),
  },
  (table) => ({
    playerIdx: index('vip_lifecycle_events_player_idx').on(table.playerId, table.receivedAt),
    purchaseIdx: index('vip_lifecycle_events_purchase_idx')
      .on(table.purchaseId)
      .where(sql`purchase_id IS NOT NULL`),
    typeCheck: check(
      'vip_lifecycle_events_event_type_chk',
      sql`event_type IN ('vip.purchased','vip.extended','vip.expired','vip.refunded')`,
    ),
    actionCheck: check(
      'vip_lifecycle_events_action_chk',
      sql`action IN ('assigned','revoked','ignored')`,
    ),
  }),
);

export type VipLifecycleEventRow = typeof vipLifecycleEvents.$inferSelect;
export type NewVipLifecycleEvent = typeof vipLifecycleEvents.$inferInsert;
