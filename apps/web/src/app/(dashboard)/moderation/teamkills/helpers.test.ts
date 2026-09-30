import { describe, expect, it } from 'vitest';
import {
  buildCombatLogTeamkillHref,
  buildPlayerTeamkillApiPath,
  buildTeamkillSummaryApiQuery,
  formatModerationSummary,
  formatTeamkillDate,
  parseTeamkillFilters,
  parseTeamkillPlayerResponse,
  teamkillSortLabel,
} from './helpers';

function params(query: string): URLSearchParams {
  return new URLSearchParams(query);
}

describe('teamkill moderation helpers', () => {
  it('parses defaults for the moderation page', () => {
    expect(parseTeamkillFilters(params(''))).toEqual({
      serverId: 'all',
      sort: 'tk_7d',
      order: 'desc',
    });
  });

  it('builds the summary API query without leaking the all-server sentinel', () => {
    const parsed = params(
      buildTeamkillSummaryApiQuery({
        serverId: 'all',
        sort: 'total',
        order: 'asc',
      }),
    );
    expect(parsed.get('sort')).toBe('total');
    expect(parsed.get('order')).toBe('asc');
    expect(parsed.get('limit')).toBe('50');
    expect(parsed.get('serverId')).toBeNull();
  });

  it('builds exact player-id combat log links for attacker and victim roles', () => {
    expect(buildCombatLogTeamkillHref({ role: 'attacker', playerId: 'attacker-id' })).toBe(
      '/combat-log?facet=teamkills&attackerPlayerId=attacker-id',
    );
    expect(buildCombatLogTeamkillHref({ role: 'victim', playerId: 'victim-id' })).toBe(
      '/combat-log?facet=teamkills&victimPlayerId=victim-id',
    );
  });

  it('formats sort labels and missing dates for compact table cells', () => {
    expect(teamkillSortLabel('tk_30d')).toBe('30 дней');
    expect(formatTeamkillDate(null)).toBe('—');
    expect(formatTeamkillDate('bad date')).toBe('—');
    expect(formatTeamkillDate('2026-07-07T18:30:00.000Z')).not.toBe('—');
  });

  it('includes the year, since the last-TK/moderation columns can show dates years apart', () => {
    expect(formatTeamkillDate('2024-01-05T09:00:00.000Z')).toContain('2024');
  });

  describe('formatModerationSummary', () => {
    it('returns an em dash when there is no moderation history', () => {
      expect(
        formatModerationSummary({
          moderation_total: 0,
          last_moderation_at: null,
          last_moderation_type: null,
        }),
      ).toBe('—');
    });

    it('formats the latest action type as a Russian label, with the date and total count', () => {
      expect(
        formatModerationSummary({
          moderation_total: 3,
          last_moderation_at: '2026-07-12T14:30:00.000Z',
          last_moderation_type: 'warn',
        }),
      ).toBe(`Предупреждение · ${formatTeamkillDate('2026-07-12T14:30:00.000Z')}, всего 3`);
    });

    it('falls back to the raw action type for a code with no Russian label', () => {
      expect(
        formatModerationSummary({
          moderation_total: 1,
          last_moderation_at: '2026-07-12T14:30:00.000Z',
          last_moderation_type: 'some_future_worker_action',
        }),
      ).toContain('some_future_worker_action ·');
    });

    it('falls back to an em dash date when last_moderation_at is null despite a positive total', () => {
      expect(
        formatModerationSummary({
          moderation_total: 1,
          last_moderation_at: null,
          last_moderation_type: 'kick',
        }),
      ).toBe('Кик · —, всего 1');
    });

    it('falls back to an em dash date for an invalid last_moderation_at', () => {
      expect(
        formatModerationSummary({
          moderation_total: 1,
          last_moderation_at: 'not-a-date',
          last_moderation_type: 'ban',
        }),
      ).toBe('Бан · —, всего 1');
    });
  });
});

describe('parseTeamkillPlayerResponse', () => {
  const stats = {
    player_id: 'p-1',
    current_name: 'Nick',
    steam_id64: null,
    eos_id: null,
    tk_total: 3,
    tk_7d: 1,
    tk_30d: 2,
    victim_of_tk_total: 0,
    last_tk_at: null,
    moderation_total: 0,
    last_moderation_at: null,
    last_moderation_type: null,
  };
  const event = {
    id: 1,
    server_id: 's-1',
    match_id: null,
    weapon: 'M4',
    occurred_at: '2026-07-01T10:00:00.000Z',
    role: 'attacker',
    attacker: { player_id: 'p-1', current_name: 'Nick' },
    victim: null,
  };

  it('accepts a well-formed body', () => {
    const body = { stats, recent: [event] };
    expect(parseTeamkillPlayerResponse(body)).toEqual(body);
  });

  // Regression (#456): the body was cast with `as` and a drifted field
  // crashed the render instead of showing an error.
  it('rejects malformed stats or events', () => {
    expect(
      parseTeamkillPlayerResponse({ stats: { ...stats, tk_7d: null }, recent: [] }),
    ).toBeNull();
    expect(
      parseTeamkillPlayerResponse({ stats, recent: [{ ...event, role: 'bystander' }] }),
    ).toBeNull();
    expect(parseTeamkillPlayerResponse({ stats })).toBeNull();
    expect(parseTeamkillPlayerResponse(null)).toBeNull();
  });
});

describe('buildPlayerTeamkillApiPath', () => {
  it('encodes the player id (#472)', () => {
    expect(buildPlayerTeamkillApiPath('../x')).toBe('/api/v1/players/..%2Fx/teamkills');
  });
});
