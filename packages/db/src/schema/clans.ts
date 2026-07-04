import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { players } from './players.js';
import { servers } from './servers.js';

export const clans = pgTable(
  'clans',
  {
    id: uuid('id').primaryKey().notNull(),
    name: text('name').notNull(),
    tags: text('tags').array().notNull().default([]),
    description: text('description'),
    maxPrioritySlots: integer('max_priority_slots').notNull().default(10),
    priorityExpiresAt: timestamp('priority_expires_at', { withTimezone: true, mode: 'date' }),
    isTagProtected: boolean('is_tag_protected').notNull().default(false),
    isPublic: boolean('is_public').notNull().default(false),
    primaryServerId: uuid('primary_server_id').references(() => servers.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
    deletedAt: timestamp('deleted_at', { withTimezone: true, mode: 'date' }),
  },
  (table) => ({
    nameActiveKey: uniqueIndex('clans_name_active_key')
      .on(table.name)
      .where(sql`deleted_at IS NULL`),
    isPublicIdx: index('clans_is_public_idx').on(table.isPublic).where(sql`deleted_at IS NULL`),
    nameLengthCheck: check(
      'clans_name_length',
      sql`char_length(name) >= 1 AND char_length(name) <= 32`,
    ),
    prioritySlotsCheck: check('clans_max_priority_slots_nonneg', sql`max_priority_slots >= 0`),
  }),
);

export const clanMembers = pgTable(
  'clan_members',
  {
    clanId: uuid('clan_id')
      .notNull()
      .references(() => clans.id, { onDelete: 'cascade' }),
    playerId: uuid('player_id')
      .notNull()
      .references(() => players.id, { onDelete: 'cascade' }),
    memberRole: text('member_role').notNull(),
    hasPriority: boolean('has_priority').notNull().default(false),
    joinedAt: timestamp('joined_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.clanId, table.playerId] }),
    playerUniqueIdx: uniqueIndex('clan_members_player_unique_idx').on(table.playerId),
    clanRoleIdx: index('clan_members_clan_role_idx').on(table.clanId, table.memberRole),
    roleCheck: check('clan_members_role_enum', sql`member_role IN ('leader','deputy','member')`),
  }),
);

export type ClanRow = typeof clans.$inferSelect;
export type NewClan = typeof clans.$inferInsert;
export type ClanMemberRow = typeof clanMembers.$inferSelect;
export type NewClanMember = typeof clanMembers.$inferInsert;
