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
    canManageIssues: boolean('can_manage_issues').notNull().default(false),
    canManageBanSources: boolean('can_manage_ban_sources').notNull().default(false),
    canManageIntegrations: boolean('can_manage_integrations').notNull().default(false),
    canManageClans: boolean('can_manage_clans').notNull().default(false),
    canManageEconomy: boolean('can_manage_economy').notNull().default(false),
    canManageMedia: boolean('can_manage_media').notNull().default(false),
    canHandleReports: boolean('can_handle_reports').notNull().default(false),
    combatView: boolean('combat_view').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
  },
  (table) => ({
    nameKey: uniqueIndex('roles_name_key').on(table.name),
  }),
);

export type RoleRow = typeof roles.$inferSelect;
export type NewRole = typeof roles.$inferInsert;
