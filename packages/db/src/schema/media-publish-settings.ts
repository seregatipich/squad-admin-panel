import { sql } from 'drizzle-orm';
import { boolean, check, pgTable, smallint, timestamp, uuid } from 'drizzle-orm/pg-core';
import { players } from './players.js';

/**
 * Singleton settings row for outbound media publishing (VIDEO-4, #160).
 * Mirrors the `banlist_publication_settings` / `clan_guard_settings` pattern.
 *
 * `releaseLocalFile` is the "free the disk after publishing" switch. It defaults
 * to **off**: primary storage is ours (VIDEO-1), and a deploy must never start
 * discarding local evidence because a feature shipped. When on, a successful
 * publication swaps `media_files.storage_path` for the destination's
 * `external_url` in a single statement — the `media_files` XOR CHECK forbids a
 * row holding both or neither, so the swap cannot be split into two writes.
 *
 * The third-party credentials themselves are deliberately absent from this
 * table: they stay in the worker's environment, and the API only ever reports
 * whether they are present.
 */
export const mediaPublishSettings = pgTable(
  'media_publish_settings',
  {
    id: smallint('id').primaryKey().default(1),
    releaseLocalFile: boolean('release_local_file').notNull().default(false),
    updatedByPlayerId: uuid('updated_by_player_id').references(() => players.id, {
      onDelete: 'set null',
    }),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
  },
  (table) => ({
    singleton: check('media_publish_settings_singleton', sql`${table.id} = 1`),
  }),
);

export type MediaPublishSettingsRow = typeof mediaPublishSettings.$inferSelect;
export type NewMediaPublishSettings = typeof mediaPublishSettings.$inferInsert;
