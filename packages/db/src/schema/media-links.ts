import { sql } from 'drizzle-orm';
import { check, index, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { mediaFiles } from './media-files.js';
import { players } from './players.js';

export const MEDIA_LINK_ENTITY_TYPES = ['player', 'moderation_action', 'match', 'issue'] as const;
export type MediaLinkEntityType = (typeof MEDIA_LINK_ENTITY_TYPES)[number];

/**
 * Canonical polymorphic evidence store — attaches a `media_files` row to a
 * player, moderation action, match, or issue (VIDEO-2, #158). `entityId` is
 * deliberately not a foreign key: it addresses one of four different target
 * tables depending on `entityType`, so existence is checked by the route
 * layer before insert rather than by the database.
 *
 * `linkedByPlayerId` is `SET NULL` on the linking player's deletion so the
 * evidence itself survives; it drives the ownership check on detach
 * (`can_manage_media` is required to remove someone else's link).
 */
export const mediaLinks = pgTable(
  'media_links',
  {
    id: uuid('id').primaryKey().notNull(),
    mediaId: uuid('media_id')
      .notNull()
      .references(() => mediaFiles.id, { onDelete: 'cascade' }),
    entityType: text('entity_type').notNull(),
    entityId: uuid('entity_id').notNull(),
    linkedByPlayerId: uuid('linked_by_player_id').references(() => players.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
  },
  (table) => ({
    entityTypeCheck: check(
      'media_links_entity_type_check',
      sql`${table.entityType} IN ('player','moderation_action','match','issue')`,
    ),
    mediaEntityKey: uniqueIndex('media_links_media_entity_key').on(
      table.mediaId,
      table.entityType,
      table.entityId,
    ),
    entityIdx: index('media_links_entity_idx').on(table.entityType, table.entityId),
    mediaIdx: index('media_links_media_idx').on(table.mediaId),
  }),
);

export type MediaLinkRow = typeof mediaLinks.$inferSelect;
export type NewMediaLink = typeof mediaLinks.$inferInsert;
