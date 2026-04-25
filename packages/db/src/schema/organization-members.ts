import { bigint, pgTable, primaryKey, timestamp, uuid } from 'drizzle-orm/pg-core';
import { organizations } from './organizations.js';
import { players } from './players.js';
import { roles } from './roles.js';

export const organizationMembers = pgTable(
  'organization_members',
  {
    steamId64: bigint('steam_id64', { mode: 'bigint' })
      .notNull()
      .references(() => players.steamId64, { onDelete: 'cascade' }),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    primaryRoleId: uuid('primary_role_id').references(() => roles.id),
    joinedAt: timestamp('joined_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.steamId64, table.orgId] }),
  }),
);

export type OrganizationMemberRow = typeof organizationMembers.$inferSelect;
export type NewOrganizationMember = typeof organizationMembers.$inferInsert;
