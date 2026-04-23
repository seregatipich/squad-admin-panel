import { pgTable, primaryKey, uuid } from 'drizzle-orm/pg-core';
import { roles } from './roles.js';
import { servers } from './servers.js';

export const roleServerScopes = pgTable(
  'role_server_scopes',
  {
    roleId: uuid('role_id')
      .notNull()
      .references(() => roles.id, { onDelete: 'cascade' }),
    serverId: uuid('server_id').references(() => servers.id, { onDelete: 'cascade' }),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.roleId, table.serverId] }),
  }),
);

export type RoleServerScopeRow = typeof roleServerScopes.$inferSelect;
export type NewRoleServerScope = typeof roleServerScopes.$inferInsert;
