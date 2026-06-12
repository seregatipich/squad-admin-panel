import { describe, expect, it } from 'vitest';
import { mapEvent } from '../src/eventMap.js';

const SERVER_ID = '019dbaa5-1234-7abc-8def-0123456789ab';
const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('mapEvent', () => {
  it('maps PLAYER_CONNECTED to the shared panel EventEnvelope', () => {
    const envelope = mapEvent(SERVER_ID, 'PLAYER_CONNECTED', {
      steamID: '76561198000000001',
      eosID: '0002eos00000000000000000000000a1',
      name: 'Sergei',
      time: '2026-04-24T10:00:00.000Z',
    });
    expect(envelope).toMatchObject({
      version: 1,
      type: 'player.connected',
      server_id: SERVER_ID,
      ts: '2026-04-24T10:00:00.000Z',
      actor: { kind: 'system', id: null },
      correlation_id: null,
      payload: {
        steam_id64: '76561198000000001',
        eos_id: '0002eos00000000000000000000000a1',
        name: 'Sergei',
        ip: null,
      },
    });
    expect(envelope?.event_id).toMatch(UUID_V7);
  });

  it('normalizes a Date time into a full ISO datetime string', () => {
    const envelope = mapEvent(SERVER_ID, 'ADMIN_BROADCAST', {
      message: 'gg',
      time: new Date('2026-04-24T10:00:00.000Z'),
    });
    expect(envelope?.ts).toBe('2026-04-24T10:00:00.000Z');
  });

  it('falls back to current ISO time when raw.time is unparseable', () => {
    const before = Date.now();
    const envelope = mapEvent(SERVER_ID, 'ADMIN_BROADCAST', { message: 'gg', time: 'not-a-date' });
    const ts = Date.parse(envelope?.ts ?? '');
    expect(Number.isNaN(ts)).toBe(false);
    expect(ts).toBeGreaterThanOrEqual(before - 1000);
  });

  it('returns null for unknown RNSquadJS event types', () => {
    expect(mapEvent(SERVER_ID, 'UNKNOWN_THING', {})).toBeNull();
  });

  const CASES: Array<[string, Record<string, unknown>, string, Record<string, unknown>]> = [
    [
      'PLAYER_DISCONNECTED',
      { steamID: 'A', eosID: 'B', name: 'X', time: '2026-04-24T10:00:00.000Z' },
      'player.disconnected',
      { steam_id64: 'A', eos_id: 'B', reason: null },
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
      { from_state: 'WaitingToStart', to_state: 'InProgress' },
    ],
    [
      'ROUND_ENDED',
      { winner: 'Team1', layer: 'Yehorivka_RAAS_v1', time: '2026-04-24T10:00:00.000Z' },
      'match.ended',
      { from_state: 'InProgress', to_state: 'WaitingPostMatch' },
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
      { player: 'P', squad_id: 3, squad_name: 'Alpha', team: 1 },
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
      { tick_rate: 39.2 },
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
      { channel: 'ChatAll', steam_id: 'A', name: 'Sergei', message: 'hi' },
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

  it.each(CASES)('maps %s', (rnType, raw, expectedType, expectedPayload) => {
    const envelope = mapEvent(SERVER_ID, rnType, raw);
    expect(envelope).not.toBeNull();
    expect(envelope?.type).toBe(expectedType);
    expect(envelope?.payload).toEqual(expectedPayload);
    expect(envelope?.server_id).toBe(SERVER_ID);
    expect(envelope?.actor).toEqual({ kind: 'system', id: null });
    expect(envelope?.correlation_id).toBeNull();
    expect(envelope?.event_id).toMatch(UUID_V7);
  });
});
