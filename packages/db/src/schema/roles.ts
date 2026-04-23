import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { organizations } from './organizations.js';

export const roles = pgTable(
  'roles',
  {
    id: uuid('id').primaryKey().notNull(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    description: text('description'),
    clearanceLevel: integer('clearance_level').notNull().default(0),
    isSystemRole: boolean('is_system_role').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
  },
  (table) => ({
    orgNameKey: uniqueIndex('roles_org_name_key').on(table.orgId, table.name),
    clearanceCheck: check('roles_clearance_range', sql`clearance_level BETWEEN 0 AND 1000`),
  }),
);

export type RoleRow = typeof roles.$inferSelect;
export type NewRole = typeof roles.$inferInsert;
