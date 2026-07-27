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

export const MEDIA_UPLOAD_TOKEN_TARGET_TYPES = [
  'player',
  'moderation_action',
  'match',
  'issue',
] as const;
export type MediaUploadTokenTargetType = (typeof MEDIA_UPLOAD_TOKEN_TARGET_TYPES)[number];

/**
 * One-time delegated-upload credentials (VIDEO-3, #159). A panel admin mints a
 * token, hands the resulting `/upload/<token>` link to an outside player, and
 * that player uploads a single file without any panel session.
 *
 * The raw token is returned to the minter exactly once and is never persisted:
 * only `tokenHash` (hex sha-256 of the raw value) is stored, so a database
 * leak cannot be replayed into upload capability. Single use is enforced by
 * the database rather than the application — redemption is a conditional
 * `UPDATE ... SET used_at = now() WHERE used_at IS NULL AND expires_at > now()
 * RETURNING id`, so two concurrent uploads can never both win the row.
 *
 * `targetEntityType`/`targetEntityId` optionally pre-bind the token to the
 * evidence target (a ban, a player, …) so the uploaded file auto-attaches via
 * `media_links` (VIDEO-2, #158); the CHECK keeps them set or unset together.
 * `issuedByPlayerId` is `SET NULL` on the minter's deletion so provenance of
 * already-uploaded evidence survives.
 */
export const mediaUploadTokens = pgTable(
  'media_upload_tokens',
  {
    id: uuid('id').primaryKey().notNull(),
    tokenHash: text('token_hash').notNull(),
    issuedByPlayerId: uuid('issued_by_player_id').references(() => players.id, {
      onDelete: 'set null',
    }),
    targetEntityType: text('target_entity_type'),
    targetEntityId: uuid('target_entity_id'),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }).notNull(),
    usedAt: timestamp('used_at', { withTimezone: true, mode: 'date' }),
    maxSizeBytes: bigint('max_size_bytes', { mode: 'number' }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
  },
  (table) => ({
    targetTypeCheck: check(
      'media_upload_tokens_target_type_check',
      sql`${table.targetEntityType} IS NULL
       OR ${table.targetEntityType} IN ('player','moderation_action','match','issue')`,
    ),
    targetPairCheck: check(
      'media_upload_tokens_target_pair_check',
      sql`(${table.targetEntityType} IS NULL) = (${table.targetEntityId} IS NULL)`,
    ),
    tokenHashKey: uniqueIndex('media_upload_tokens_token_hash_key').on(table.tokenHash),
    expiresAtIdx: index('media_upload_tokens_expires_at_idx').on(table.expiresAt),
  }),
);

export type MediaUploadTokenRow = typeof mediaUploadTokens.$inferSelect;
export type NewMediaUploadToken = typeof mediaUploadTokens.$inferInsert;
