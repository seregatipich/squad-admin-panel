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
import { players } from './players.js';
import { vipTiers } from './vip-tiers.js';

/** Lifecycle of a recurring VIP subscription (VIPSUB-5). */
export const VIP_SUBSCRIPTION_STATUSES = ['active', 'cancelled', 'expired'] as const;
export type VipSubscriptionStatus = (typeof VIP_SUBSCRIPTION_STATUSES)[number];

/**
 * Recurring VIP subscriptions (VIPSUB-5, #171).
 *
 * A subscription is the panel-side billing record for a {@link vipTiers} tier
 * paid for in internal ECON bonus points — there is no payment provider in
 * this system, and integrating one is explicitly out of scope. Each period the
 * `role-expirer` renewal tick charges {@link vipSubscriptions.priceBonuses} and
 * pushes `players.role_expires_at` forward by
 * {@link vipSubscriptions.renewsEveryDays}; when the balance is short the row
 * flips to `expired` and the existing role-expiry tick removes the role once
 * the paid period runs out.
 *
 * `price_bonuses` and `renews_every_days` are **snapshots** taken when the
 * subscription is created, deliberately not read back from `vip_tiers`: editing
 * the catalog must never silently reprice a live subscription.
 *
 * Cancelling only sets `status`/`cancelled_at` — the paid period is never
 * clawed back, so the role and its expiry are left alone.
 */
export const vipSubscriptions = pgTable(
  'vip_subscriptions',
  {
    id: uuid('id').primaryKey().notNull(),
    playerId: uuid('player_id')
      .notNull()
      .references(() => players.id, { onDelete: 'cascade' }),
    tierId: uuid('tier_id')
      .notNull()
      .references(() => vipTiers.id, { onDelete: 'restrict' }),
    status: text('status').notNull().default('active'),
    /** Period length in days; also the amount `role_expires_at` moves on renewal. */
    renewsEveryDays: integer('renews_every_days').notNull(),
    /** Price charged per period, snapshotted from the tier at creation time. */
    priceBonuses: integer('price_bonuses').notNull(),
    nextRenewalAt: timestamp('next_renewal_at', { withTimezone: true, mode: 'date' }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
    cancelledAt: timestamp('cancelled_at', { withTimezone: true, mode: 'date' }),
  },
  (table) => ({
    dueIdx: index('vip_subscriptions_due_idx').on(table.status, table.nextRenewalAt),
    playerIdx: index('vip_subscriptions_player_idx').on(table.playerId),
    /** One live subscription per player — a duplicate purchase answers 409. */
    oneActiveIdx: uniqueIndex('vip_subscriptions_one_active_idx')
      .on(table.playerId)
      .where(sql`status = 'active'`),
    statusChk: check(
      'vip_subscriptions_status_chk',
      sql`${table.status} IN ('active','cancelled','expired')`,
    ),
    renewsEveryDaysChk: check(
      'vip_subscriptions_renews_every_days_chk',
      sql`${table.renewsEveryDays} > 0`,
    ),
    priceBonusesChk: check('vip_subscriptions_price_bonuses_chk', sql`${table.priceBonuses} >= 0`),
  }),
);

export type VipSubscriptionRow = typeof vipSubscriptions.$inferSelect;
export type NewVipSubscription = typeof vipSubscriptions.$inferInsert;
