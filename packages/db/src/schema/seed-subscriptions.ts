import { sql } from 'drizzle-orm';
import { check, index, pgTable, primaryKey, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { players } from './players.js';
import { servers } from './servers.js';

/**
 * Per-player opt-in channels for SEED-4 notifications on a server.
 * A composite primary key makes the toggle operation idempotent without
 * introducing an otherwise-unused surrogate identifier.
 */
export const seedSubscriptions = pgTable(
  'seed_subscriptions',
  {
    playerId: uuid('player_id')
      .notNull()
      .references(() => players.id, { onDelete: 'cascade' }),
    serverId: uuid('server_id')
      .notNull()
      .references(() => servers.id, { onDelete: 'cascade' }),
    channel: text('channel').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
  },
  (table) => ({
    primaryKey: primaryKey({ columns: [table.playerId, table.serverId, table.channel] }),
    serverChannelIdx: index('seed_subscriptions_server_channel_idx').on(
      table.serverId,
      table.channel,
    ),
    channelChk: check(
      'seed_subscriptions_channel_chk',
      sql`${table.channel} IN ('email','webpush')`,
    ),
  }),
);

export type SeedSubscriptionRow = typeof seedSubscriptions.$inferSelect;
export type NewSeedSubscription = typeof seedSubscriptions.$inferInsert;
