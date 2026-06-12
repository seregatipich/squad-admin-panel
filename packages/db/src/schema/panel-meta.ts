import { sql } from 'drizzle-orm';
import { boolean, check, pgTable, smallint, text, timestamp } from 'drizzle-orm/pg-core';

export const panelMeta = pgTable(
  'panel_meta',
  {
    id: smallint('id').primaryKey().default(1),
    firstOwnerClaimed: boolean('first_owner_claimed').notNull().default(false),
    rolesSeeded: boolean('roles_seeded').notNull().default(false),
    setupCompleted: boolean('setup_completed').notNull().default(false),
    organizationName: text('organization_name').notNull().default(''),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
  },
  (table) => ({
    singleton: check('panel_meta_singleton', sql`${table.id} = 1`),
  }),
);

export type PanelMetaRow = typeof panelMeta.$inferSelect;
