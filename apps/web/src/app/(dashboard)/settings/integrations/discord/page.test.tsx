import { describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({
  redirect: vi.fn(),
  useRouter: vi.fn(() => ({ push: vi.fn(), refresh: vi.fn() })),
  usePathname: vi.fn(() => '/settings/integrations/discord'),
  useSearchParams: vi.fn(() => new URLSearchParams()),
}));
vi.mock('@/components/LiveIndicator', () => ({ LiveIndicator: () => null }));

import { DISCORD_EVENT_TYPES, eventLabel, looksLikeWebhookUrl } from './discord-events';
import DiscordIntegrationPage from './page';

describe('DiscordIntegrationPage', () => {
  it('is a valid React component', () => {
    expect(DiscordIntegrationPage).toBeDefined();
    expect(typeof DiscordIntegrationPage).toBe('function');
  });

  it('exposes the twelve fixed event types', () => {
    expect(DISCORD_EVENT_TYPES).toHaveLength(12);
    expect(DISCORD_EVENT_TYPES).toContain('server_crashed');
    expect(DISCORD_EVENT_TYPES).toContain('server_monitoring');
  });

  it('maps event types to Russian labels and falls back to the raw key', () => {
    expect(eventLabel('ban_issued')).toBe('Выдан бан');
    expect(eventLabel('unknown_event')).toBe('unknown_event');
  });

  it('accepts real discord webhook urls and rejects everything else', () => {
    expect(
      looksLikeWebhookUrl('https://discord.com/api/webhooks/123456789012345678/abcDEF_-.123'),
    ).toBe(true);
    expect(
      looksLikeWebhookUrl('https://discordapp.com/api/v10/webhooks/12345/tok_en-value.1'),
    ).toBe(true);
    expect(looksLikeWebhookUrl('https://evil.example/api/webhooks/1/2')).toBe(false);
    expect(looksLikeWebhookUrl('not a url')).toBe(false);
    expect(looksLikeWebhookUrl('')).toBe(false);
  });
});
