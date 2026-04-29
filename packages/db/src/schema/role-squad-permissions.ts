import { index, pgTable, primaryKey, text, uuid } from 'drizzle-orm/pg-core';
import { roles } from './roles.js';

export const roleSquadPermissions = pgTable(
  'role_squad_permissions',
  {
    roleId: uuid('role_id')
      .notNull()
      .references(() => roles.id, { onDelete: 'cascade' }),
    squadPermissionKey: text('squad_permission_key').notNull(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.roleId, table.squadPermissionKey] }),
    roleIdx: index('role_squad_permissions_role_idx').on(table.roleId),
  }),
);

export type RoleSquadPermissionRow = typeof roleSquadPermissions.$inferSelect;
export type NewRoleSquadPermission = typeof roleSquadPermissions.$inferInsert;
