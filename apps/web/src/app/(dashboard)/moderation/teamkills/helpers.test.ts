import { describe, expect, it } from 'vitest';
import {
  buildCombatLogTeamkillHref,
  buildTeamkillSummaryApiQuery,
  formatModerationSummary,
  formatTeamkillDate,
  parseTeamkillFilters,
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

    it('formats the latest action type, date and total count', () => {
      expect(
        formatModerationSummary({
          moderation_total: 3,
          last_moderation_at: '2026-07-12T14:30:00.000Z',
          last_moderation_type: 'warn',
        }),
      ).toBe(`warn · ${formatTeamkillDate('2026-07-12T14:30:00.000Z')}, всего 3`);
    });

    it('falls back to an em dash date when last_moderation_at is null despite a positive total', () => {
      expect(
        formatModerationSummary({
          moderation_total: 1,
          last_moderation_at: null,
          last_moderation_type: 'kick',
        }),
      ).toBe('kick · —, всего 1');
    });

    it('falls back to an em dash date for an invalid last_moderation_at', () => {
      expect(
        formatModerationSummary({
          moderation_total: 1,
          last_moderation_at: 'not-a-date',
          last_moderation_type: 'ban',
        }),
      ).toBe('ban · —, всего 1');
    });
  });
});
