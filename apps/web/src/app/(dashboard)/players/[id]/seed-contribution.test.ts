import { describe, expect, it } from 'vitest';
import {
  buildSeedContributionUrl,
  DEFAULT_SEED_CONTRIBUTION_DAYS,
  formatSeedDuration,
  parseSeedContribution,
  type SeedContributionResponse,
  type SeedServerContribution,
  serverLabel,
  sortServersBySeedSeconds,
} from './seed-contribution';

function validPayload(overrides: Partial<SeedContributionResponse> = {}): SeedContributionResponse {
  return {
    window: { from: '2026-06-15', to: '2026-07-14', days: 30 },
    total_seed_seconds: 3661,
    by_server: [
      { server_id: 's1', server_name: 'Server One', server_slug: 'srv-1', seed_seconds: 3661 },
    ],
    series: [{ day: '2026-07-14', seed_seconds: 3661 }],
    bonus: { k_seed: 3, earned_points: 10 },
    ...overrides,
  };
}

describe('formatSeedDuration', () => {
  it('formats zero as 0ч 0м', () => {
    expect(formatSeedDuration(0)).toBe('0ч 0м');
  });

  it('formats a negative or non-finite value as 0ч 0м', () => {
    expect(formatSeedDuration(-5)).toBe('0ч 0м');
    expect(formatSeedDuration(Number.NaN)).toBe('0ч 0м');
  });

  it('formats 3661 seconds as 1ч 1м', () => {
    expect(formatSeedDuration(3661)).toBe('1ч 1м');
  });

  it('formats large values with multi-hour output', () => {
    expect(formatSeedDuration(36_000 + 90)).toBe('10ч 1м');
  });

  it('floors fractional seconds', () => {
    expect(formatSeedDuration(119.9)).toBe('0ч 1м');
  });
});

describe('buildSeedContributionUrl', () => {
  it('defaults to the 30-day window', () => {
    expect(buildSeedContributionUrl('p1')).toBe(
      `/api/v1/players/p1/seed-contribution?days=${DEFAULT_SEED_CONTRIBUTION_DAYS}`,
    );
  });

  it('honors an explicit days value', () => {
    expect(buildSeedContributionUrl('p1', 7)).toBe('/api/v1/players/p1/seed-contribution?days=7');
  });
});

describe('parseSeedContribution', () => {
  it('parses a valid payload', () => {
    const payload = validPayload();
    expect(parseSeedContribution(payload)).toEqual(payload);
  });

  it('rejects null/non-object input', () => {
    expect(parseSeedContribution(null)).toBeNull();
    expect(parseSeedContribution('not an object')).toBeNull();
  });

  it('rejects a payload missing the window', () => {
    const { window: _window, ...rest } = validPayload();
    expect(parseSeedContribution(rest)).toBeNull();
  });

  it('rejects a payload missing bonus fields', () => {
    const payload = validPayload({ bonus: { k_seed: 3 } as never });
    expect(parseSeedContribution(payload)).toBeNull();
  });

  it('rejects a payload with a malformed by_server entry', () => {
    const payload = validPayload({ by_server: [{ server_id: 's1' } as never] });
    expect(parseSeedContribution(payload)).toBeNull();
  });

  it('rejects a payload with a malformed series entry', () => {
    const payload = validPayload({ series: [{ day: '2026-07-14' } as never] });
    expect(parseSeedContribution(payload)).toBeNull();
  });

  it('accepts an empty by_server/series (player with no presence)', () => {
    const payload = validPayload({ total_seed_seconds: 0, by_server: [], series: [] });
    expect(parseSeedContribution(payload)).toEqual(payload);
  });
});

describe('serverLabel', () => {
  it('prefers the slug over the display name', () => {
    expect(serverLabel({ server_slug: 'srv-1', server_name: 'Server One' })).toBe('srv-1');
  });

  it('falls back to the display name when the slug is null', () => {
    expect(serverLabel({ server_slug: null, server_name: 'Server One' })).toBe('Server One');
  });

  it('falls back to an em dash when both are null', () => {
    expect(serverLabel({ server_slug: null, server_name: null })).toBe('—');
  });
});

describe('sortServersBySeedSeconds', () => {
  it('sorts descending by seed_seconds, tie-broken by label', () => {
    const servers: SeedServerContribution[] = [
      { server_id: 'a', server_name: null, server_slug: 'b-server', seed_seconds: 100 },
      { server_id: 'b', server_name: null, server_slug: 'a-server', seed_seconds: 100 },
      { server_id: 'c', server_name: null, server_slug: 'z-server', seed_seconds: 500 },
    ];
    expect(sortServersBySeedSeconds(servers).map((s) => s.server_id)).toEqual(['c', 'b', 'a']);
  });
});
