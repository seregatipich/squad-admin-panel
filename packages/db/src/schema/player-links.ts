import { sql } from 'drizzle-orm';
import {
  check,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { players } from './players.js';

/** Admin-decided classification of a confirmed/rejected `player_links` pair (ALT-2, issue #120). */
export const PLAYER_LINK_TYPES = ['alt', 'family_share', 'same_household', 'unrelated'] as const;
export type PlayerLinkType = (typeof PLAYER_LINK_TYPES)[number];

export const PLAYER_LINK_STATUSES = ['confirmed', 'rejected'] as const;
export type PlayerLinkStatus = (typeof PLAYER_LINK_STATUSES)[number];

/**
 * Manually confirmed/rejected relationships between two player accounts —
 * the durable verdict layer on top of the ALT-1 candidate engine
 * (`apps/api/src/routes/player-alt-candidates.ts`), which only ever produces
 * ephemeral, re-computed suggestions. An undirected edge with no duplicates:
 * `player_a_id`/`player_b_id` are stored in canonical order
 * (`player_a_id < player_b_id`, enforced by `player_links_pair_order_chk`)
 * so a confirmation made from either side of the pair lands on the same
 * row, and `player_links_pair_key` rejects a second decision for the same
 * pair with a unique-violation the route surfaces as 409. There is no
 * DELETE — rejecting a previously confirmed pair (or vice versa) is a
 * `status` update via PATCH, keeping the decision history intact.
 */
export const playerLinks = pgTable(
  'player_links',
  {
    id: uuid('id').primaryKey().notNull().default(sql`gen_random_uuid()`),
    playerAId: uuid('player_a_id')
      .notNull()
      .references(() => players.id, { onDelete: 'cascade' }),
    playerBId: uuid('player_b_id')
      .notNull()
      .references(() => players.id, { onDelete: 'cascade' }),
    linkType: text('link_type').notNull(),
    status: text('status').notNull(),
    /** Signals snapshot from the ALT-1 candidate row at decision time (score, confidence, shared IPs/names). */
    evidenceSnapshot: jsonb('evidence_snapshot'),
    note: text('note'),
    createdBy: uuid('created_by').references(() => players.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
  },
  (table) => ({
    pairKey: uniqueIndex('player_links_pair_key').on(table.playerAId, table.playerBId),
    playerBIdx: index('player_links_player_b_idx').on(table.playerBId),
    pairOrderChk: check(
      'player_links_pair_order_chk',
      sql`${table.playerAId} < ${table.playerBId}`,
    ),
    linkTypeChk: check(
      'player_links_link_type_chk',
      sql`${table.linkType} IN ('alt', 'family_share', 'same_household', 'unrelated')`,
    ),
    statusChk: check('player_links_status_chk', sql`${table.status} IN ('confirmed', 'rejected')`),
  }),
);

export type PlayerLinkRow = typeof playerLinks.$inferSelect;
export type NewPlayerLink = typeof playerLinks.$inferInsert;
