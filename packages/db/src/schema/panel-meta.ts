import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  integer,
  pgTable,
  smallint,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { roles } from './roles.js';

export const panelMeta = pgTable(
  'panel_meta',
  {
    id: smallint('id').primaryKey().default(1),
    firstOwnerClaimed: boolean('first_owner_claimed').notNull().default(false),
    rolesSeeded: boolean('roles_seeded').notNull().default(false),
    setupCompleted: boolean('setup_completed').notNull().default(false),
    organizationName: text('organization_name').notNull().default(''),
    whitelistRoleId: uuid('whitelist_role_id').references(() => roles.id, {
      onDelete: 'set null',
    }),
    // WL-3 (#67): public whitelist/VIP application portal switch. Off by default
    // so a deploy never silently exposes a public write endpoint. When on, an
    // approved application grants the resolved role for `default_days` days
    // (NULL = permanent) unless the reviewer overrides the term.
    whitelistApplicationsEnabled: boolean('whitelist_applications_enabled')
      .notNull()
      .default(false),
    whitelistApplicationDefaultDays: integer('whitelist_application_default_days'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
  },
  (table) => ({
    singleton: check('panel_meta_singleton', sql`${table.id} = 1`),
  }),
);

export type PanelMetaRow = typeof panelMeta.$inferSelect;
