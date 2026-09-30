import { describe, expect, it } from 'vitest';
import { isDiscordWebhookUrl, maskWebhookUrl } from '../../src/lib/discord.js';

describe('isDiscordWebhookUrl', () => {
  it('accepts an HTTPS Discord webhook URL', () => {
    expect(isDiscordWebhookUrl('https://discord.com/api/webhooks/123456/abc-DEF_1.2')).toBe(true);
    expect(isDiscordWebhookUrl('https://ptb.discord.com/api/v10/webhooks/123456/token')).toBe(true);
    expect(isDiscordWebhookUrl('https://discordapp.com/api/webhooks/123456/token')).toBe(true);
  });

  it('rejects a plain-HTTP webhook URL, whose token would travel in cleartext (#66)', () => {
    expect(isDiscordWebhookUrl('http://discord.com/api/webhooks/123456/token')).toBe(false);
  });

  it('rejects a non-Discord host', () => {
    expect(isDiscordWebhookUrl('https://discord.com.evil.example/api/webhooks/1/t')).toBe(false);
  });
});

describe('maskWebhookUrl', () => {
  it('hides the token and most of the webhook id', () => {
    expect(maskWebhookUrl('https://discord.com/api/webhooks/123456789/secret')).toBe(
      '…/1234…/****',
    );
  });
});
