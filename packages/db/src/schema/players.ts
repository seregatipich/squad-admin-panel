import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  index,
  inet,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { roles } from './roles.js';

export const players = pgTable(
  'players',
  {
    id: uuid('id').primaryKey().notNull().default(sql`gen_random_uuid()`),
    steamId64: bigint('steam_id64', { mode: 'bigint' }),
    canonicalName: text('canonical_name').notNull(),
    canonicalNameNormalized: text('canonical_name_normalized').notNull(),
    eosId: text('eos_id'),
    battleEyeGuid: text('battle_eye_guid'),
    steamEosConflict: boolean('steam_eos_conflict').notNull().default(false),
    lastKnownIp: inet('last_known_ip'),
    roleId: uuid('role_id').references(() => roles.id, { onDelete: 'set null' }),
    roleExpiresAt: timestamp('role_expires_at', { withTimezone: true, mode: 'date' }),
    roleComment: text('role_comment'),
    firstSeenAt: timestamp('first_seen_at', { withTimezone: true, mode: 'date' })
      .defaultNow()
      .notNull(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true, mode: 'date' })
      .defaultNow()
      .notNull(),
    totalTimePlayedSeconds: bigint('total_time_played_seconds', { mode: 'number' })
      .notNull()
      .default(0),
    bonusBalance: integer('bonus_balance').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
  },
  (table) => ({
    steamId64UniqueIdx: uniqueIndex('players_steam_id64_unique_idx').on(table.steamId64),
    eosIdUniqueIdx: uniqueIndex('players_eos_id_unique_idx')
      .on(table.eosId)
      .where(sql`eos_id IS NOT NULL`),
    canonicalNameNormalizedIdx: index('players_canonical_name_normalized_idx').on(
      table.canonicalNameNormalized,
    ),
    lastSeenAtIdx: index('players_last_seen_at_idx').on(table.lastSeenAt),
    roleIdIdx: index('players_role_id_idx').on(table.roleId).where(sql`role_id IS NOT NULL`),
    roleExpiresAtIdx: index('players_role_expires_at_idx')
      .on(table.roleExpiresAt)
      .where(sql`role_id IS NOT NULL AND role_expires_at IS NOT NULL`),
    bonusBalanceChk: check('players_bonus_balance_nonneg_chk', sql`bonus_balance >= 0`),
  }),
);

export type PlayerRow = typeof players.$inferSelect;
export type NewPlayer = typeof players.$inferInsert;
