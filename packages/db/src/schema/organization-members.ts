import { pgTable, primaryKey, timestamp, uuid } from 'drizzle-orm/pg-core';
import { organizations } from './organizations.js';
import { roles } from './roles.js';
import { users } from './users.js';

export const organizationMembers = pgTable(
  'organization_members',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    primaryRoleId: uuid('primary_role_id').references(() => roles.id),
    joinedAt: timestamp('joined_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.userId, table.orgId] }),
  }),
);

export type OrganizationMemberRow = typeof organizationMembers.$inferSelect;
export type NewOrganizationMember = typeof organizationMembers.$inferInsert;
