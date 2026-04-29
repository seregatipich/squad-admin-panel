import { boolean, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

export const roles = pgTable(
  'roles',
  {
    id: uuid('id').primaryKey().notNull(),
    name: text('name').notNull(),
    description: text('description'),
    color: text('color').notNull().default('neutral'),
    isSystemRole: boolean('is_system_role').notNull().default(false),
    panelAccess: boolean('panel_access').notNull().default(false),
    canAssignRoles: boolean('can_assign_roles').notNull().default(false),
    canEditRoles: boolean('can_edit_roles').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
  },
  (table) => ({
    nameKey: uniqueIndex('roles_name_key').on(table.name),
  }),
);

export type RoleRow = typeof roles.$inferSelect;
export type NewRole = typeof roles.$inferInsert;
