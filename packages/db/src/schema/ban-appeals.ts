import { sql } from 'drizzle-orm';
import {
  bigint,
  bigserial,
  check,
  index,
  inet,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { moderationActions } from './moderation-actions.js';
import { players } from './players.js';

/**
 * Ban-appeal portal queue (MOD-5, #62). A row is created by an anonymous,
 * unauthenticated submission to `POST /api/v1/public/appeals` — a banned
 * player has no panel session by definition — and worked through the panel
 * queue gated on `mod:unban`.
 *
 * {@link playerId} is nullable on purpose: the portal accepts a submission for
 * any SteamID64, including one the panel has never seen, so the response
 * cannot be used to enumerate which SteamIDs are banned. Resolution is
 * best-effort at submit time, and approving an appeal without a resolved
 * player simply has no bans to revert.
 *
 * {@link trackingToken} is the applicant's only handle on the appeal: it is
 * returned once at submission and is the sole key to the public status page.
 * {@link decisionNote} is shown to the applicant through that page;
 * {@link internalNote} never leaves the panel.
 *
 * The partial unique index keys on `steam_id64` rather than `player_id`
 * because `player_id` is nullable (NULLs never collide, so it would not stop
 * spam for unresolved SteamIDs) — one open appeal per SteamID64, mirroring
 * `whitelist_applications_pending_steam_unique_idx`.
 */
export const banAppeals = pgTable(
  'ban_appeals',
  {
    id: uuid('id').primaryKey().notNull().default(sql`gen_random_uuid()`),
    number: bigserial('number', { mode: 'number' }).notNull(),
    playerId: uuid('player_id').references(() => players.id, { onDelete: 'cascade' }),
    moderationActionId: uuid('moderation_action_id').references(() => moderationActions.id, {
      onDelete: 'set null',
    }),
    steamId64: bigint('steam_id64', { mode: 'bigint' }).notNull(),
    body: text('body').notNull(),
    contact: text('contact'),
    status: text('status').notNull().default('pending'),
    handlerPlayerId: uuid('handler_player_id').references(() => players.id, {
      onDelete: 'set null',
    }),
    decisionNote: text('decision_note'),
    internalNote: text('internal_note'),
    trackingToken: text('tracking_token').notNull(),
    submitterIp: inet('submitter_ip'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
    decidedAt: timestamp('decided_at', { withTimezone: true, mode: 'date' }),
  },
  (table) => ({
    numberKey: uniqueIndex('ban_appeals_number_key').on(table.number),
    trackingTokenKey: uniqueIndex('ban_appeals_tracking_token_key').on(table.trackingToken),
    statusCreatedIdx: index('ban_appeals_status_created_idx').on(table.status, table.createdAt),
    playerIdx: index('ban_appeals_player_idx').on(table.playerId),
    actionIdx: index('ban_appeals_action_idx').on(table.moderationActionId),
    openSteamUnique: uniqueIndex('ban_appeals_open_steam_unique_idx')
      .on(table.steamId64)
      .where(sql`status IN ('pending','in_review')`),
    statusCheck: check(
      'ban_appeals_status_enum',
      sql`status IN ('pending','in_review','approved','rejected')`,
    ),
    bodyLenCheck: check('ban_appeals_body_len', sql`char_length(body) <= 4000`),
    contactLenCheck: check(
      'ban_appeals_contact_len',
      sql`contact IS NULL OR char_length(contact) <= 200`,
    ),
    decisionNoteLenCheck: check(
      'ban_appeals_decision_note_len',
      sql`decision_note IS NULL OR char_length(decision_note) <= 2000`,
    ),
    internalNoteLenCheck: check(
      'ban_appeals_internal_note_len',
      sql`internal_note IS NULL OR char_length(internal_note) <= 2000`,
    ),
  }),
);

export type BanAppealRow = typeof banAppeals.$inferSelect;
export type NewBanAppeal = typeof banAppeals.$inferInsert;
