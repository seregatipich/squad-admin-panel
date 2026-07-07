import { boolean, integer, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
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
    sortOrder: integer('sort_order').notNull().default(0),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
  },
  (table) => ({
    nameKey: uniqueIndex('vip_tiers_name_key').on(table.name),
  }),
);

export type VipTierRow = typeof vipTiers.$inferSelect;
export type NewVipTier = typeof vipTiers.$inferInsert;
