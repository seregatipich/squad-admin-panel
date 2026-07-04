import { getTableColumns, getTableName } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import {
  DISCORD_EVENT_TYPES,
  discordIntegration,
  discordWebhooks,
  isDiscordEventType,
} from '../src/schema/discord.js';
import { roles } from '../src/schema/roles.js';

describe('discord schema', () => {
  it('discord_integration is a singleton-shaped table with a nullable encrypted bot token', () => {
    expect(getTableName(discordIntegration)).toBe('discord_integration');
    const cols = getTableColumns(discordIntegration);
    expect(cols.id.notNull).toBe(true);
    expect(cols.guildId.notNull).toBe(false);
    expect(cols.botTokenEncrypted.notNull).toBe(false);
    expect(cols.enabled.notNull).toBe(true);
  });

  it('discord_webhooks stores the url encrypted and never nullable', () => {
    expect(getTableName(discordWebhooks)).toBe('discord_webhooks');
    const cols = getTableColumns(discordWebhooks);
    expect(cols.webhookUrlEncrypted.notNull).toBe(true);
    expect(cols.eventType.notNull).toBe(true);
    expect(cols.channelLabel.notNull).toBe(false);
    expect(cols.mentionEveryone.notNull).toBe(true);
    expect(cols.serverId.notNull).toBe(false);
  });

  it('exposes the fixed twelve event types', () => {
    expect(DISCORD_EVENT_TYPES).toHaveLength(12);
    expect(DISCORD_EVENT_TYPES).toContain('server_crashed');
    expect(DISCORD_EVENT_TYPES).toContain('drift_detected');
    expect(isDiscordEventType('ban_issued')).toBe(true);
    expect(isDiscordEventType('not_a_real_event')).toBe(false);
  });

  it('adds the can_manage_integrations panel flag to roles', () => {
    const cols = getTableColumns(roles);
    expect(cols.canManageIntegrations.notNull).toBe(true);
  });
});
