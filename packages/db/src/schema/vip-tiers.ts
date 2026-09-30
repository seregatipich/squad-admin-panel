import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { roles } from './roles.js';

/**
 * VIP privilege tiers catalog (VIPSUB-3).
 *
 * A tier is a sellable package that maps to an existing RBAC role. Squad queue
 * priority is binary (`reserve`), so tiers differ by the composition of their
 * role's squad permissions and panel perks — captured in {@link vipTiers.description}.
 * Granting a tier means granting its {@link vipTiers.roleId} role through VIPSUB-1
 * (using the tier's {@link vipTiers.defaultDays} when present).
 */
export const vipTiers = pgTable(
  'vip_tiers',
  {
    id: uuid('id').primaryKey().notNull(),
    name: text('name').notNull(),
    roleId: uuid('role_id')
      .notNull()
      .references(() => roles.id, { onDelete: 'restrict' }),
    description: text('description'),
    /** Default subscription length in days applied on grant; NULL means no default. */
    defaultDays: integer('default_days'),
    /**
     * Bonus-point price in the internal privilege shop (ECON-6). NULL means the
     * tier is not purchasable. A non-NULL price requires {@link vipTiers.defaultDays}
     * (enforced by `vip_tiers_price_requires_days_chk`), because a purchase is
     * always a timed grant.
     */
    priceBonuses: integer('price_bonuses'),
    sortOrder: integer('sort_order').notNull().default(0),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
  },
  (table) => ({
    nameKey: uniqueIndex('vip_tiers_name_key').on(table.name),
    roleIdIdx: index('vip_tiers_role_id_idx').on(table.roleId),
    purchasableIdx: index('vip_tiers_purchasable_idx')
      .on(table.isActive)
      .where(sql`price_bonuses IS NOT NULL`),
    defaultDaysPositiveChk: check(
      'vip_tiers_default_days_positive',
      sql`default_days IS NULL OR default_days > 0`,
    ),
    priceBonusesNonnegChk: check(
      'vip_tiers_price_bonuses_nonneg_chk',
      sql`price_bonuses IS NULL OR price_bonuses >= 0`,
    ),
    priceRequiresDaysChk: check(
      'vip_tiers_price_requires_days_chk',
      sql`price_bonuses IS NULL OR default_days IS NOT NULL`,
    ),
  }),
);

export type VipTierRow = typeof vipTiers.$inferSelect;
export type NewVipTier = typeof vipTiers.$inferInsert;
