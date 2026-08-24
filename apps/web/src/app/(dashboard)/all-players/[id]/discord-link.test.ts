import { describe, expect, it } from 'vitest';

import {
  buildDiscordLinkUrl,
  buildForceUnlinkUrl,
  DISCORD_OAUTH_LOGIN_URL,
  formatLinkedAt,
  parseDiscordLink,
  SELF_UNLINK_URL,
} from './discord-link';

describe('URL builders', () => {
  it('builds the read path for a player card', () => {
    expect(buildDiscordLinkUrl('player-alpha')).toBe('/api/v1/players/player-alpha/discord');
  });

  it('builds the force-unlink path for a player card', () => {
    expect(buildForceUnlinkUrl('player-alpha')).toBe('/api/v1/players/player-alpha/discord/link');
  });

  it('exposes the fixed self-unlink and OAuth entry points', () => {
    expect(SELF_UNLINK_URL).toBe('/api/v1/players/me/discord/link');
    expect(DISCORD_OAUTH_LOGIN_URL).toBe('/api/v1/auth/discord/login');
  });
});

describe('parseDiscordLink', () => {
  it('accepts a fully populated linked payload', () => {
    expect(
      parseDiscordLink({
        linked: true,
        discord_user_id: '111222333444555666',
        discord_username: 'Сквадди',
        linked_at: '2026-07-20T10:30:00.000Z',
      }),
    ).toEqual({
      linked: true,
      discord_user_id: '111222333444555666',
      discord_username: 'Сквадди',
      linked_at: '2026-07-20T10:30:00.000Z',
    });
  });

  it('accepts an unlinked payload with null fields', () => {
    expect(
      parseDiscordLink({
        linked: false,
        discord_user_id: null,
        discord_username: null,
        linked_at: null,
      }),
    ).toEqual({
      linked: false,
      discord_user_id: null,
      discord_username: null,
      linked_at: null,
    });
  });

  it('rejects a non-object body', () => {
    expect(parseDiscordLink(null)).toBeNull();
    expect(parseDiscordLink('linked')).toBeNull();
  });

  it('rejects a body whose linked flag is not a boolean', () => {
    expect(
      parseDiscordLink({
        linked: 'yes',
        discord_user_id: null,
        discord_username: null,
        linked_at: null,
      }),
    ).toBeNull();
  });

  it('rejects a body whose nullable fields carry the wrong type', () => {
    expect(
      parseDiscordLink({
        linked: true,
        discord_user_id: 42,
        discord_username: 'Сквадди',
        linked_at: null,
      }),
    ).toBeNull();
  });
});

describe('formatLinkedAt', () => {
  /* Полдень по локальному времени: дата не переползает на соседний день ни в
     одном часовом поясе, в котором может запуститься тест. */
  const NOON_20_JULY_2026 = new Date(2026, 6, 20, 12, 0, 0).toISOString();

  it('renders the timestamp in the panel locale, not the browser one', () => {
    expect(formatLinkedAt(NOON_20_JULY_2026, 'ru-RU')).toBe('20.07.2026');
    expect(formatLinkedAt(NOON_20_JULY_2026, 'en-GB')).toBe('20/07/2026');
  });

  it('renders an em dash for a missing timestamp', () => {
    expect(formatLinkedAt(null, 'ru-RU')).toBe('—');
  });

  it('renders an em dash for an unparsable timestamp', () => {
    expect(formatLinkedAt('not-a-date', 'ru-RU')).toBe('—');
  });
});
