import { bigint, index, pgTable, primaryKey, timestamp, uuid } from 'drizzle-orm/pg-core';
import { players } from './players.js';
import { roles } from './roles.js';

export const playerRoleAssignments = pgTable(
  'player_role_assignments',
  {
    steamId64: bigint('steam_id64', { mode: 'bigint' })
      .notNull()
      .references(() => players.steamId64, { onDelete: 'cascade' }),
    roleId: uuid('role_id')
      .notNull()
      .references(() => roles.id, { onDelete: 'cascade' }),
    assignedBy: bigint('assigned_by', { mode: 'bigint' }).references(() => players.steamId64, {
      onDelete: 'set null',
    }),
    assignedAt: timestamp('assigned_at', { withTimezone: true, mode: 'date' })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.steamId64, table.roleId] }),
    roleIdx: index('player_role_assignments_role_idx').on(table.roleId),
  }),
);

export type PlayerRoleAssignmentRow = typeof playerRoleAssignments.$inferSelect;
export type NewPlayerRoleAssignment = typeof playerRoleAssignments.$inferInsert;
