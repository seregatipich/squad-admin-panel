import { boolean, customType, integer, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { servers } from './servers.js';

const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType() {
    return 'bytea';
  },
});

export const DISCORD_EVENT_TYPES = [
  'server_crashed',
  'ban_issued',
  'unban',
  'kick',
  'warn',
  'admin_login',
  'player_report',
  'match_ended',
  'map_changed',
  'marked_player_joined',
  'drift_detected',
  'server_monitoring',
] as const;

export type DiscordEventType = (typeof DISCORD_EVENT_TYPES)[number];

const DISCORD_EVENT_TYPE_SET: ReadonlySet<string> = new Set(DISCORD_EVENT_TYPES);

export function isDiscordEventType(value: string): value is DiscordEventType {
  return DISCORD_EVENT_TYPE_SET.has(value);
}

export const DISCORD_INTEGRATION_SINGLETON_ID = '00000000-0000-0000-0000-0000000d15c0';

export const discordIntegration = pgTable('discord_integration', {
  id: uuid('id').primaryKey().notNull(),
  guildId: text('guild_id'),
  botTokenEncrypted: bytea('bot_token_encrypted'),
  enabled: boolean('enabled').notNull().default(false),
  keyVersion: integer('key_version').notNull().default(1),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
});

export const discordWebhooks = pgTable('discord_webhooks', {
  id: uuid('id').primaryKey().notNull(),
  eventType: text('event_type').notNull(),
  webhookUrlEncrypted: bytea('webhook_url_encrypted').notNull(),
  channelLabel: text('channel_label'),
  enabled: boolean('enabled').notNull().default(true),
  mentionEveryone: boolean('mention_everyone').notNull().default(false),
  serverId: uuid('server_id').references(() => servers.id, { onDelete: 'set null' }),
  keyVersion: integer('key_version').notNull().default(1),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
});

export type DiscordIntegrationRow = typeof discordIntegration.$inferSelect;
export type NewDiscordIntegration = typeof discordIntegration.$inferInsert;
export type DiscordWebhookRow = typeof discordWebhooks.$inferSelect;
export type NewDiscordWebhook = typeof discordWebhooks.$inferInsert;
