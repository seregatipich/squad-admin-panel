import { pgTable, primaryKey, uuid } from 'drizzle-orm/pg-core';
import { roles } from './roles.js';
import { users } from './users.js';

export const userRoleAssignments = pgTable(
  'user_role_assignments',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    roleId: uuid('role_id')
      .notNull()
      .references(() => roles.id, { onDelete: 'cascade' }),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.userId, table.roleId] }),
  }),
);

export type UserRoleAssignmentRow = typeof userRoleAssignments.$inferSelect;
export type NewUserRoleAssignment = typeof userRoleAssignments.$inferInsert;
