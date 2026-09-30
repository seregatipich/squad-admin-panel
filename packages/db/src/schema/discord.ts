import type { DiscordEmbedTemplate } from '@squad/shared-config/discord-template';
import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { bytea } from './_types.js';
import { servers } from './servers.js';

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
  'seed_needed',
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

const DISCORD_TEMPLATE_LOCALE_VALUES = ['en', 'ru'] as const;

/**
 * One editable embed template per Discord event type (DISCORD-3).
 *
 * `event_type` is unique, so an event has exactly one template and the sender
 * never selects by language. `locale` is descriptive metadata: the language the
 * stored embed text is written in, shown to operators and returned by the API.
 * It is not a lookup key. Making templates multilingual would relax the unique
 * key to `(event_type, locale)`, which the previous release's single-row
 * lookups cannot tolerate, so it stays a two-release change (#1127).
 */
export const discordMessageTemplates = pgTable(
  'discord_message_templates',
  {
    id: uuid('id').primaryKey().defaultRandom().notNull(),
    eventType: text('event_type').notNull().unique(),
    locale: text('locale').notNull().default('en'),
    /** Editable embed; typed from shared-config so every reader sees the real shape. */
    template: jsonb('template').$type<DiscordEmbedTemplate>().notNull(),
    isDefault: boolean('is_default').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
  },
  (table) => ({
    eventTypeChk: check(
      'discord_message_templates_event_type_chk',
      sql`${table.eventType} IN (${sql.raw(DISCORD_EVENT_TYPES.map((type) => `'${type}'`).join(','))})`,
    ),
    localeChk: check(
      'discord_message_templates_locale_chk',
      sql`${table.locale} IN (${sql.raw(DISCORD_TEMPLATE_LOCALE_VALUES.map((locale) => `'${locale}'`).join(','))})`,
    ),
  }),
);

export type DiscordMessageTemplateRow = typeof discordMessageTemplates.$inferSelect;
export type NewDiscordMessageTemplate = typeof discordMessageTemplates.$inferInsert;

export type DiscordIntegrationRow = typeof discordIntegration.$inferSelect;
export type NewDiscordIntegration = typeof discordIntegration.$inferInsert;
export type DiscordWebhookRow = typeof discordWebhooks.$inferSelect;
export type NewDiscordWebhook = typeof discordWebhooks.$inferInsert;
