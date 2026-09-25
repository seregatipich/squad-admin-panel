import { describe, expect, it } from 'vitest';
import {
  EVENTS_APPENDED_PG_CHANNEL,
  encodeRconRefreshHint,
  parseRconRefreshHint,
  RCON_REFRESH_CHANNEL,
  rconRefreshScopesForEvent,
} from '../src/live-refresh.js';

describe('live-refresh channel names', () => {
  it('are fixed wire contracts shared by producers and consumers', () => {
    expect(RCON_REFRESH_CHANNEL).toBe('rcon:refresh');
    expect(EVENTS_APPENDED_PG_CHANNEL).toBe('events_appended');
  });
});

describe('rcon refresh hint codec', () => {
  it('round-trips a hint', () => {
    const hint = { server_id: 'srv-1', scopes: ['roster' as const], reason: 'player.connected' };
    expect(parseRconRefreshHint(encodeRconRefreshHint(hint))).toEqual(hint);
  });

  it('keeps only known scopes and dedupes them', () => {
    expect(
      parseRconRefreshHint(
        JSON.stringify({ server_id: 'srv-1', scopes: ['info', 'bogus', 'info', 'roster'] }),
      ),
    ).toEqual({ server_id: 'srv-1', scopes: ['info', 'roster'] });
  });

  it('drops a non-string reason instead of carrying it', () => {
    expect(
      parseRconRefreshHint(JSON.stringify({ server_id: 's', scopes: ['roster'], reason: 5 })),
    ).toEqual({ server_id: 's', scopes: ['roster'] });
  });

  it.each([
    ['not json', '{'],
    ['null', 'null'],
    ['a number', '42'],
    ['missing server id', JSON.stringify({ scopes: ['roster'] })],
    ['empty server id', JSON.stringify({ server_id: '', scopes: ['roster'] })],
    ['numeric server id', JSON.stringify({ server_id: 7, scopes: ['roster'] })],
    ['scopes not an array', JSON.stringify({ server_id: 's', scopes: 'roster' })],
    ['no known scope', JSON.stringify({ server_id: 's', scopes: ['map'] })],
    ['empty scopes', JSON.stringify({ server_id: 's', scopes: [] })],
  ])('rejects %s', (_label, raw) => {
    expect(parseRconRefreshHint(raw)).toBeNull();
  });
});

describe('rconRefreshScopesForEvent', () => {
  it('asks for a roster refresh on joins and leaves', () => {
    expect(rconRefreshScopesForEvent('player.connected')).toEqual(['roster']);
    expect(rconRefreshScopesForEvent('player.disconnected')).toEqual(['roster']);
  });

  it('asks for roster and server info on a match boundary', () => {
    expect(rconRefreshScopesForEvent('match.started')).toEqual(['roster', 'info']);
    expect(rconRefreshScopesForEvent('match.ended')).toEqual(['roster', 'info']);
  });

  it('ignores events RCON does not report on', () => {
    expect(rconRefreshScopesForEvent('player.name_changed')).toBeNull();
    expect(rconRefreshScopesForEvent('combat_damage')).toBeNull();
    expect(rconRefreshScopesForEvent('')).toBeNull();
  });
});
