import { sql } from 'drizzle-orm';
import { check, index, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { players } from './players.js';
import { servers } from './servers.js';

/**
 * Per-player moderation ledger. Records enforcement actions taken against a
 * player — automated (banned-name / external-ban / clan-tag kicks) or manual
 * (moderator kicks, warns, report resolutions) — and powers the "moderation
 * history" surfaced on the player card.
 *
 * The author is either a panel user ({@link authorPlayerId}) or the system
 * ({@link authorSystemLabel}, e.g. `banname-worker`); the check constraint
 * guarantees at least one is present. Reversible actions (e.g. a name-ban that
 * was later lifted) are marked with {@link revertedAt}/{@link revertedBy}
 * rather than deleted, preserving history. Free-form details (rule_id,
 * source_id, external_ban_id, report_id, …) live in {@link context}.
 */
export const moderationActions = pgTable(
  'moderation_actions',
  {
    id: uuid('id').primaryKey().notNull().default(sql`gen_random_uuid()`),
    playerId: uuid('player_id')
      .notNull()
      .references(() => players.id, { onDelete: 'cascade' }),
    serverId: uuid('server_id').references(() => servers.id, { onDelete: 'set null' }),
    actionType: text('action_type').notNull(),
    authorPlayerId: uuid('author_player_id').references(() => players.id, { onDelete: 'set null' }),
    authorSystemLabel: text('author_system_label'),
    reason: text('reason'),
    context: jsonb('context').notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
    revertedAt: timestamp('reverted_at', { withTimezone: true, mode: 'date' }),
    revertedBy: uuid('reverted_by').references(() => players.id, { onDelete: 'set null' }),
  },
  (table) => ({
    playerCreatedIdx: index('moderation_actions_player_created_idx').on(
      table.playerId,
      table.createdAt,
    ),
    actionTypeIdx: index('moderation_actions_action_type_idx').on(
      table.actionType,
      table.createdAt,
    ),
    serverCreatedIdx: index('moderation_actions_server_created_idx').on(
      table.serverId,
      table.createdAt,
    ),
    authorPresentCheck: check(
      'moderation_actions_author_present',
      sql`author_player_id IS NOT NULL OR author_system_label IS NOT NULL`,
    ),
  }),
);

export type ModerationActionRow = typeof moderationActions.$inferSelect;
export type NewModerationAction = typeof moderationActions.$inferInsert;
