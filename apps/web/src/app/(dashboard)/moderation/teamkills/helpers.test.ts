import { describe, expect, it } from 'vitest';
import {
  buildCombatLogTeamkillHref,
  buildTeamkillSummaryApiQuery,
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
});
