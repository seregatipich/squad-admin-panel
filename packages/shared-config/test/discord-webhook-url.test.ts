import { describe, expect, it } from 'vitest';
import { isDiscordWebhookUrl } from '../src/discord-template.js';

describe('isDiscordWebhookUrl', () => {
  it('accepts canonical https webhook URLs on discord hosts', () => {
    expect(isDiscordWebhookUrl('https://discord.com/api/webhooks/123456/abc-DEF_1.2')).toBe(true);
    expect(isDiscordWebhookUrl('https://ptb.discord.com/api/v10/webhooks/123456/token')).toBe(true);
    expect(isDiscordWebhookUrl('https://discordapp.com/api/webhooks/123456/token')).toBe(true);
  });

  it('rejects plain http, lookalike hosts and malformed values', () => {
    expect(isDiscordWebhookUrl('http://discord.com/api/webhooks/123456/token')).toBe(false);
    expect(isDiscordWebhookUrl('https://discord.com.evil.example/api/webhooks/1/t')).toBe(false);
    expect(isDiscordWebhookUrl('not a url')).toBe(false);
    expect(isDiscordWebhookUrl('')).toBe(false);
  });
});
