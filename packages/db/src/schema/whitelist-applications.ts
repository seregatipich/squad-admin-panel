import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { players } from './players.js';
import { roles } from './roles.js';

/**
 * Public whitelist/VIP application portal (WL-3, #67). A row is created either
 * by an anonymous public submission (`source='public'`) or by a panel operator
 * (`source='panel'`), and reviewed via the panel approval workflow. Approving a
 * `pending` row grants the resolved role to the matching `players` row —
 * optionally time-bounded via `players.role_expires_at` (mirrored here in
 * `grantedUntil`), which the existing `worker-role-expirer` later clears. The
 * partial unique index blocks a second `pending` application for the same
 * SteamID64 while one is already open.
 */
export const whitelistApplications = pgTable(
  'whitelist_applications',
  {
    id: uuid('id').primaryKey().notNull().default(sql`gen_random_uuid()`),
    steamId64: bigint('steam_id64', { mode: 'bigint' }).notNull(),
    playerId: uuid('player_id').references(() => players.id, { onDelete: 'set null' }),
    contact: text('contact'),
    body: text('body').notNull(),
    requestedRoleId: uuid('requested_role_id').references(() => roles.id, { onDelete: 'set null' }),
    status: text('status').notNull().default('pending'),
    reviewerPlayerId: uuid('reviewer_player_id').references(() => players.id, {
      onDelete: 'set null',
    }),
    reviewNote: text('review_note'),
    grantedRoleId: uuid('granted_role_id').references(() => roles.id, { onDelete: 'set null' }),
    grantedUntil: timestamp('granted_until', { withTimezone: true, mode: 'date' }),
    source: text('source').notNull().default('public'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
    decidedAt: timestamp('decided_at', { withTimezone: true, mode: 'date' }),
  },
  (table) => ({
    statusCreatedIdx: index('whitelist_applications_status_created_idx').on(
      table.status,
      table.createdAt,
    ),
    steamIdIdx: index('whitelist_applications_steam_id64_idx').on(table.steamId64),
    pendingSteamUnique: uniqueIndex('whitelist_applications_pending_steam_unique_idx')
      .on(table.steamId64)
      .where(sql`status = 'pending'`),
    statusCheck: check(
      'whitelist_applications_status_enum',
      sql`status IN ('pending','approved','rejected')`,
    ),
    sourceCheck: check('whitelist_applications_source_enum', sql`source IN ('public','panel')`),
  }),
);

export type WhitelistApplicationRow = typeof whitelistApplications.$inferSelect;
export type NewWhitelistApplication = typeof whitelistApplications.$inferInsert;
