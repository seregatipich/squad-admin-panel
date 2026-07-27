import { sql } from 'drizzle-orm';
import { bigint, check, index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { mediaUploadTokens } from './media-upload-tokens.js';
import { players } from './players.js';

export const MEDIA_KINDS = ['video', 'image', 'external_link'] as const;
export type MediaKind = (typeof MEDIA_KINDS)[number];

/**
 * Media library — uploaded video/image files stored on local disk, or
 * registered external links (e.g. YouTube/Twitch clips). Exactly one of
 * `storagePath` / `externalUrl` is set, enforced by a CHECK constraint.
 *
 * Uploaded files are addressed on disk via `storagePath` (relative to the
 * configured media base dir, see `apps/api/src/lib/media-storage.ts`) and
 * deduplicated by `sha256` — re-uploading identical bytes reuses the
 * existing row's `storagePath` instead of writing the file twice.
 *
 * `uploadTokenId` is set only for files delivered through a one-time
 * delegated-upload link (VIDEO-3, #159). It is both the provenance record and
 * the untrusted marker: such a row always has `uploaderPlayerId = NULL`
 * because the uploader had no panel session at all.
 */
export const mediaFiles = pgTable(
  'media_files',
  {
    id: uuid('id').primaryKey().notNull(),
    uploaderPlayerId: uuid('uploader_player_id').references(() => players.id, {
      onDelete: 'set null',
    }),
    uploadTokenId: uuid('upload_token_id').references(() => mediaUploadTokens.id, {
      onDelete: 'set null',
    }),
    kind: text('kind').notNull(),
    originalFilename: text('original_filename').notNull(),
    mimeType: text('mime_type').notNull(),
    sizeBytes: bigint('size_bytes', { mode: 'number' }).notNull(),
    sha256: text('sha256').notNull(),
    storagePath: text('storage_path'),
    externalUrl: text('external_url'),
    title: text('title'),
    description: text('description'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
    deletedAt: timestamp('deleted_at', { withTimezone: true, mode: 'date' }),
  },
  (table) => ({
    kindCheck: check(
      'media_files_kind_check',
      sql`${table.kind} IN ('video','image','external_link')`,
    ),
    exactlyOneLocationCheck: check(
      'media_files_exactly_one_location_check',
      sql`(${table.storagePath} IS NOT NULL AND ${table.externalUrl} IS NULL)
       OR (${table.storagePath} IS NULL AND ${table.externalUrl} IS NOT NULL)`,
    ),
    sha256Idx: index('media_files_sha256_idx').on(table.sha256),
    uploaderIdx: index('media_files_uploader_idx').on(table.uploaderPlayerId, table.createdAt),
    createdAtIdx: index('media_files_created_at_idx').on(table.createdAt),
  }),
);

export type MediaFileRow = typeof mediaFiles.$inferSelect;
export type NewMediaFile = typeof mediaFiles.$inferInsert;
