import { pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { players } from './players.js';

/**
 * Discord identity bound to a panel player by the OAuth2 `identify` flow
 * (DISCORD-4, issue #151). The relationship is strictly 1:1 in both
 * directions and the database is what enforces it: `player_id` is the primary
 * key (one link per player) and `discord_user_id` is unique (one player per
 * Discord account). `apps/api/src/routes/auth-discord.ts` turns the resulting
 * unique violation (SQLSTATE 23505) into a 409 rather than pre-checking and
 * racing.
 *
 * `discord_username` is a **snapshot** taken at link time — Discord display
 * names change, and refreshing them needs a bot session (DISCORD-6), so this
 * column is deliberately never auto-updated.
 *
 * This is panel-only data: it must never be selected by a `public-*` route
 * (guarded by `apps/api/test/security/discord-link-public-leak.test.ts`).
 */
export const playerDiscordLinks = pgTable('player_discord_links', {
  playerId: uuid('player_id')
    .primaryKey()
    .notNull()
    .references(() => players.id, { onDelete: 'cascade' }),
  discordUserId: text('discord_user_id').notNull().unique(),
  discordUsername: text('discord_username').notNull(),
  linkedAt: timestamp('linked_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
});

export type PlayerDiscordLinkRow = typeof playerDiscordLinks.$inferSelect;
export type NewPlayerDiscordLink = typeof playerDiscordLinks.$inferInsert;
