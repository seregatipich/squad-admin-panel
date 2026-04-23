import { pgTable, primaryKey, text, uuid } from 'drizzle-orm/pg-core';
import { roles } from './roles.js';

export const rolePermissions = pgTable(
  'role_permissions',
  {
    roleId: uuid('role_id')
      .notNull()
      .references(() => roles.id, { onDelete: 'cascade' }),
    permissionKey: text('permission_key').notNull(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.roleId, table.permissionKey] }),
  }),
);

export type RolePermissionRow = typeof rolePermissions.$inferSelect;
export type NewRolePermission = typeof rolePermissions.$inferInsert;
