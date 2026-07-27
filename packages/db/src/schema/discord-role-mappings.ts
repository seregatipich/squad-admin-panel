import { boolean, index, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { roles } from './roles.js';

/**
 * Panel role → Discord guild role mapping (DISCORD-5, issue #152). The panel is
 * the source of truth: `apps/workers/discord/src/role-sync.ts` drives every
 * linked player's Discord roles from `players.role_id` joined through this
 * table, both reactively (a `discord:role-sync` stream request published by the
 * API after a role assignment commits) and on the hourly reconcile tick.
 *
 * `role_id` is unique — one panel role maps to at most one Discord role, which
 * is the cardinality SQSTAT's `vip_sync`/`moderator_sync` uses. Widening this to
 * N Discord roles per panel role means dropping the unique index and moving it
 * onto the `(role_id, discord_role_id)` pair; the worker already computes over
 * a set, so only the constraint would change.
 *
 * The set of `discord_role_id`s in this table is exactly the set of Discord
 * roles the panel manages. The worker never adds or removes a Discord role
 * outside it, so an operator can hand-manage any other guild role without the
 * reconcile tick fighting them.
 *
 * Only `source = panel_role` exists today — the value is synthesised by the API
 * rather than stored, because leaderboard-driven roles (top-kills, playtime
 * tiers) are a post-STATS-3 extension and will need their own columns anyway.
 */
export const discordRoleMappings = pgTable(
  'discord_role_mappings',
  {
    id: uuid('id').primaryKey().notNull(),
    roleId: uuid('role_id')
      .notNull()
      .references(() => roles.id, { onDelete: 'cascade' }),
    discordRoleId: text('discord_role_id').notNull(),
    enabled: boolean('enabled').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
  },
  (table) => ({
    roleIdKey: uniqueIndex('discord_role_mappings_role_id_key').on(table.roleId),
    discordRoleIdIdx: index('discord_role_mappings_discord_role_id_idx').on(table.discordRoleId),
  }),
);

export type DiscordRoleMappingRow = typeof discordRoleMappings.$inferSelect;
export type NewDiscordRoleMapping = typeof discordRoleMappings.$inferInsert;
