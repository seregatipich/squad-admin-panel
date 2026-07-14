import type { EventEnvelope } from '@squad/shared-types';
import { describe, expect, it } from 'vitest';
import { buildTemplateContext, mapEventToDiscordType } from '../src/mapping.js';

function envelope(overrides: Partial<EventEnvelope>): EventEnvelope {
  return {
    event_id: '11111111-1111-1111-1111-111111111111',
    version: 1,
    type: 'server.crashed',
    server_id: '22222222-2222-2222-2222-222222222222',
    ts: '2026-07-14T00:00:00.000Z',
    actor: null,
    correlation_id: null,
    payload: null,
    ...overrides,
  };
}

describe('mapEventToDiscordType', () => {
  it('maps server.crashed to server_crashed', () => {
    expect(mapEventToDiscordType('server.crashed')).toBe('server_crashed');
  });

  it('maps match.ended to match_ended', () => {
    expect(mapEventToDiscordType('match.ended')).toBe('match_ended');
  });

  it('maps match.started to map_changed', () => {
    expect(mapEventToDiscordType('match.started')).toBe('map_changed');
  });

  it('maps manual and automatic seed calls to seed_needed', () => {
    expect(mapEventToDiscordType('seed.call_sent')).toBe('seed_needed');
    expect(mapEventToDiscordType('server.seeding_started')).toBe('seed_needed');
  });

  it('maps every moderation event to its configured Discord type', () => {
    expect(mapEventToDiscordType('moderation.ban')).toBe('ban_issued');
    expect(mapEventToDiscordType('moderation.kick')).toBe('kick');
    expect(mapEventToDiscordType('moderation.warn')).toBe('warn');
    expect(mapEventToDiscordType('moderation.unban')).toBe('unban');
  });

  it('maps an in-game player report to player_report', () => {
    expect(mapEventToDiscordType('player_report')).toBe('player_report');
  });

  it('returns null for event types with no configured Discord notification', () => {
    expect(mapEventToDiscordType('player.connected')).toBeNull();
    expect(mapEventToDiscordType('rcon.connected')).toBeNull();
    expect(mapEventToDiscordType('bridge.connected')).toBeNull();
    expect(mapEventToDiscordType('performance.degraded')).toBeNull();
  });
});

describe('buildTemplateContext', () => {
  it('fills server_name from the resolved server name', () => {
    const context = buildTemplateContext({
      envelope: envelope({}),
      serverName: 'RU #1 Sunny',
      panelBaseUrl: null,
    });
    expect(context.server_name).toBe('RU #1 Sunny');
  });

  it('omits server_name when the server could not be resolved', () => {
    const context = buildTemplateContext({
      envelope: envelope({}),
      serverName: null,
      panelBaseUrl: null,
    });
    expect(context.server_name).toBeUndefined();
  });

  it('reads map from a match payload layer field', () => {
    const context = buildTemplateContext({
      envelope: envelope({
        type: 'match.started',
        payload: {
          from_state: 'warmup',
          to_state: 'live',
          layer: 'Narva_RAAS_v1',
          game_mode: 'RAAS',
        },
      }),
      serverName: null,
      panelBaseUrl: null,
    });
    expect(context.map).toBe('Narva_RAAS_v1');
  });

  it('reads reason from a server lifecycle payload', () => {
    const context = buildTemplateContext({
      envelope: envelope({
        type: 'server.crashed',
        payload: { pid: 123, reason: 'oom', exit_code: 137 },
      }),
      serverName: null,
      panelBaseUrl: null,
    });
    expect(context.reason).toBe('oom');
  });

  it('reads a Steam join link from a seed-call payload', () => {
    const context = buildTemplateContext({
      envelope: envelope({
        type: 'seed.call_sent',
        payload: {
          server_name: 'RU #1',
          join_link: 'steam://connect/10.0.0.1:27015',
          seed_layer: 'Sumari Seed v1',
          scheduled_for: null,
          source: 'manual',
          message: 'Нужен сид',
        },
      }),
      serverName: null,
      panelBaseUrl: null,
    });
    expect(context.join_link).toBe('steam://connect/10.0.0.1:27015');
    expect(context.map).toBe('Sumari Seed v1');
  });

  it('omits fields the payload does not carry', () => {
    const context = buildTemplateContext({
      envelope: envelope({ payload: {} }),
      serverName: null,
      panelBaseUrl: null,
    });
    expect(context.map).toBeUndefined();
    expect(context.reason).toBeUndefined();
    expect(context.player_name).toBeUndefined();
    expect(context.player_url).toBeUndefined();
  });

  it('extracts generic player identity fields when a payload carries them', () => {
    const context = buildTemplateContext({
      envelope: envelope({
        type: 'player.connected',
        payload: { steam_id64: '76561198000000001', eos_id: null, name: 'Игрок', ip: null },
      }),
      serverName: null,
      panelBaseUrl: null,
    });
    expect(context.player_name).toBe('Игрок');
    expect(context.steam_id64).toBe('76561198000000001');
  });

  it('builds player_url only when a player_id and panelBaseUrl are both present', () => {
    const withoutBaseUrl = buildTemplateContext({
      envelope: envelope({ payload: { player_id: 'p-1' } }),
      serverName: null,
      panelBaseUrl: null,
    });
    expect(withoutBaseUrl.player_url).toBeUndefined();

    const withBaseUrl = buildTemplateContext({
      envelope: envelope({ payload: { player_id: 'p-1' } }),
      serverName: null,
      panelBaseUrl: 'https://panel.example',
    });
    expect(withBaseUrl.player_url).toBe('https://panel.example/players/p-1');
  });

  it('extracts moderation template fields', () => {
    const context = buildTemplateContext({
      envelope: envelope({
        type: 'moderation.ban',
        payload: {
          moderation_action_id: '33333333-3333-3333-3333-333333333333',
          action_type: 'ban',
          player_id: '44444444-4444-4444-4444-444444444444',
          steam_id64: '76561198000000001',
          eos_id: null,
          name: 'Нарушитель',
          reason: 'Читы',
          duration: '7d',
          actor_name: 'Администратор',
          report_id: null,
        },
      }),
      serverName: 'RU #1',
      panelBaseUrl: 'https://panel.test',
    });

    expect(context).toMatchObject({
      player_name: 'Нарушитель',
      reason: 'Читы',
      duration: '7d',
      actor_name: 'Администратор',
      player_url: 'https://panel.test/players/44444444-4444-4444-4444-444444444444',
    });
  });

  it('uses report payload aliases for player, reason, actor, and player URL', () => {
    const context = buildTemplateContext({
      envelope: envelope({
        type: 'player_report',
        payload: {
          report_id: '33333333-3333-3333-3333-333333333333',
          reporter_player_id: null,
          reporter_name: 'Репортёр',
          target_player_id: '44444444-4444-4444-4444-444444444444',
          target_raw: 'Нарушитель',
          body: 'Тимкилл',
          channel: 'ChatAll',
          source: 'ingame',
        },
      }),
      serverName: 'RU #1',
      panelBaseUrl: 'https://panel.test',
    });

    expect(context).toMatchObject({
      player_name: 'Нарушитель',
      reason: 'Тимкилл',
      actor_name: 'Репортёр',
      player_url: 'https://panel.test/players/44444444-4444-4444-4444-444444444444',
    });
  });

  it('handles a null payload without throwing', () => {
    const context = buildTemplateContext({
      envelope: envelope({ payload: null }),
      serverName: 'X',
      panelBaseUrl: null,
    });
    expect(context).toEqual({ server_name: 'X' });
  });
});
