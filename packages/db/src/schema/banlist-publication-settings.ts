import { sql } from 'drizzle-orm';
import { boolean, check, pgTable, smallint, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { players } from './players.js';

/** Default publication scope: publish every active (non-reverted) ban. */
export const BANLIST_PUBLICATION_DEFAULT_SCOPE = 'all_active';

/**
 * Singleton settings row (CBAN-5) controlling outbound banlist federation:
 * when `enabled` is false, `GET /api/v1/public/banlist` responds 404
 * regardless of caller scope; when true, the endpoint serves active
 * (non-reverted) `ban` rows from `moderation_actions`, filtered further by
 * `publishScope` — `all_active` includes every non-expired ban, while
 * `permanent_only` drops temporary bans. Mirrors the `clan_guard_settings`
 * singleton pattern.
 */
export const banlistPublicationSettings = pgTable(
  'banlist_publication_settings',
  {
    id: smallint('id').primaryKey().default(1),
    enabled: boolean('enabled').notNull().default(false),
    publishScope: text('publish_scope').notNull().default(BANLIST_PUBLICATION_DEFAULT_SCOPE),
    updatedByPlayerId: uuid('updated_by_player_id').references(() => players.id, {
      onDelete: 'set null',
    }),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
  },
  (table) => ({
    singleton: check('banlist_publication_settings_singleton', sql`${table.id} = 1`),
    publishScopeValid: check(
      'banlist_publication_settings_scope_valid',
      sql`${table.publishScope} IN ('all_active', 'permanent_only')`,
    ),
  }),
);

export type BanlistPublicationSettingsRow = typeof banlistPublicationSettings.$inferSelect;
export type NewBanlistPublicationSettings = typeof banlistPublicationSettings.$inferInsert;
