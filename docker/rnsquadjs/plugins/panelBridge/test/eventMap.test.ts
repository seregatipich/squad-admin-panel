import { describe, expect, it } from 'vitest';
import { mapEvent } from '../src/eventMap.js';

describe('mapEvent', () => {
  it('maps PLAYER_CONNECTED to a panel EventEnvelope', () => {
    const envelope = mapEvent('019dbaa5-1234-7abc-8def-0123456789ab', 'PLAYER_CONNECTED', {
      steamID: '76561198000000001',
      eosID: '0002eos00000000000000000000000a1',
      name: 'Sergei',
      time: '2026-04-24T10:00:00.000Z',
    });
    expect(envelope).toMatchObject({
      serverId: '019dbaa5-1234-7abc-8def-0123456789ab',
      type: 'player.connected',
      version: 1,
      payload: {
        steamId: '76561198000000001',
        eosId: '0002eos00000000000000000000000a1',
        name: 'Sergei',
      },
    });
    expect(envelope.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(envelope.ts).toBe('2026-04-24T10:00:00.000Z');
  });

  it('returns null for unknown RNSquadJS event types', () => {
    expect(mapEvent('019dbaa5-1234-7abc-8def-0123456789ab', 'UNKNOWN_THING', {})).toBeNull();
  });

  const CASES: Array<[string, Record<string, unknown>, string, Record<string, unknown>]> = [
    [
      'PLAYER_DISCONNECTED',
      { steamID: 'A', eosID: 'B', name: 'X', time: '2026-04-24T10:00:00.000Z' },
      'player.disconnected',
      { steamId: 'A', eosId: 'B', name: 'X' },
    ],
    [
      'PLAYER_DAMAGED',
      {
        attacker: 'A',
        victim: 'V',
        weapon: 'M4A1',
        damage: 32,
        time: '2026-04-24T10:00:00.000Z',
      },
      'player.damaged',
      { attacker: 'A', victim: 'V', weapon: 'M4A1', damage: 32 },
    ],
    [
      'PLAYER_DIED',
      { attacker: 'A', victim: 'V', weapon: 'M4A1', time: '2026-04-24T10:00:00.000Z' },
      'player.died',
      { attacker: 'A', victim: 'V', weapon: 'M4A1' },
    ],
    [
      'PLAYER_WOUNDED',
      { attacker: 'A', victim: 'V', weapon: 'M4A1', time: '2026-04-24T10:00:00.000Z' },
      'player.wounded',
      { attacker: 'A', victim: 'V', weapon: 'M4A1' },
    ],
    [
      'PLAYER_REVIVED',
      { reviver: 'R', revived: 'V', time: '2026-04-24T10:00:00.000Z' },
      'player.revived',
      { reviver: 'R', revived: 'V' },
    ],
    [
      'PLAYER_POSSESS',
      { player: 'P', possessClassname: 'BP_Soldier_C', time: '2026-04-24T10:00:00.000Z' },
      'player.possess',
      { player: 'P', vehicle: 'BP_Soldier_C' },
    ],
    [
      'PLAYER_UNPOSSESS',
      { player: 'P', possessClassname: 'BP_Soldier_C', time: '2026-04-24T10:00:00.000Z' },
      'player.unpossess',
      { player: 'P', vehicle: 'BP_Soldier_C' },
    ],
    [
      'NEW_GAME',
      { layer: 'Yehorivka_RAAS_v1', time: '2026-04-24T10:00:00.000Z' },
      'match.started',
      { layer: 'Yehorivka_RAAS_v1' },
    ],
    [
      'ROUND_ENDED',
      { winner: 'Team1', layer: 'Yehorivka_RAAS_v1', time: '2026-04-24T10:00:00.000Z' },
      'match.ended',
      { winner: 'Team1', layer: 'Yehorivka_RAAS_v1' },
    ],
    [
      'SQUAD_CREATED',
      {
        player: 'P',
        squadID: 3,
        squadName: 'Alpha',
        team: 1,
        time: '2026-04-24T10:00:00.000Z',
      },
      'squad.created',
      { player: 'P', squadId: 3, squadName: 'Alpha', team: 1 },
    ],
    [
      'DEPLOYABLE_DAMAGED',
      {
        deployable: 'BP_FOB_Radio_C',
        damage: 100,
        attacker: 'A',
        time: '2026-04-24T10:00:00.000Z',
      },
      'deployable.damaged',
      { deployable: 'BP_FOB_Radio_C', damage: 100, attacker: 'A' },
    ],
    [
      'TICK_RATE',
      { tickRate: 39.2, time: '2026-04-24T10:00:00.000Z' },
      'server.tick_rate',
      { tickRate: 39.2 },
    ],
    [
      'ADMIN_BROADCAST',
      { message: 'gg', time: '2026-04-24T10:00:00.000Z' },
      'admin.broadcast',
      { message: 'gg' },
    ],
    [
      'CHAT_MESSAGE',
      {
        chat: 'ChatAll',
        name: 'Sergei',
        message: 'hi',
        steamID: 'A',
        time: '2026-04-24T10:00:00.000Z',
      },
      'chat.message',
      { channel: 'ChatAll', steamId: 'A', name: 'Sergei', message: 'hi' },
    ],
    [
      'POSSESSED_ADMIN_CAMERA',
      { player: 'P', time: '2026-04-24T10:00:00.000Z' },
      'admin.camera_entered',
      { player: 'P' },
    ],
    [
      'UNPOSSESSED_ADMIN_CAMERA',
      { player: 'P', time: '2026-04-24T10:00:00.000Z' },
      'admin.camera_left',
      { player: 'P' },
    ],
  ];

  it.each(CASES)('maps %s', (_rnType, raw, expectedType, expectedPayload) => {
    const env = mapEvent('019dbaa5-1234-7abc-8def-0123456789ab', _rnType, raw);
    expect(env).not.toBeNull();
    expect(env?.type).toBe(expectedType);
    expect(env?.payload).toEqual(expectedPayload);
  });
});
