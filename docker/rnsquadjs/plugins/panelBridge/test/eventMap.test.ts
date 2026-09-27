import { describe, expect, it } from 'vitest';
import { isPublishablePayload, type KnownPlayer, mapEvent } from '../src/eventMap.js';

const SERVER_ID = '019dbaa5-1234-7abc-8def-0123456789ab';
const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const STEAM_A = '76561198000000001';
const EOS_A = '0002a10186d9414496bf20d22d3860ba';
const STEAM_B = '76561198000000002';
const EOS_B = '0002b20297ea525507c031e33e4971cb';
const SQUAD_TIME = '2026.04.24-16.12.12:945';
const SQUAD_TIME_ISO = '2026-04-24T16:12:12.945Z';

const PLAYERS: Record<string, KnownPlayer> = {
  [EOS_A]: { steamID: STEAM_A, name: 'Sergei' },
  [EOS_B]: { steamID: STEAM_B, name: 'Ivan' },
};
const findPlayer = (eosId: string): KnownPlayer | undefined => PLAYERS[eosId];

// Fixtures below mirror the exact objects the pinned squad-logs parsers
// (lACTEPUKCl/squad-logs@c0136352, used by RNSquadJS d76fb4a) and squad-rcon
// 1.1.8 emit: field names, types and the `YYYY.MM.DD-HH.mm.ss:SSS` log time.
const RAW = {
  PLAYER_CONNECTED: {
    raw: `[${SQUAD_TIME}][412]LogSquad: PostLogin: NewPlayer: BP_PlayerController_C /Game/Maps/Yehorivka/Yehorivka.Yehorivka:PersistentLevel.BP_PlayerController_C_2147481234 (IP: 203.0.113.7 | Online IDs: EOS: ${EOS_A} steam: ${STEAM_A})`,
    time: SQUAD_TIME,
    chainID: '412',
    playerController: 'BP_PlayerController_C_2147481234',
    ip: '203.0.113.7',
    eosID: EOS_A,
    steamID: STEAM_A,
    event: 'PLAYER_CONNECTED',
  },
  PLAYER_DISCONNECTED: {
    raw: `[${SQUAD_TIME}][413]LogNet: UChannel::Close: …`,
    time: SQUAD_TIME,
    chainID: '413',
    ip: '203.0.113.7',
    playerController: 'BP_PlayerController_C_2147481234',
    eosID: EOS_A.toUpperCase(),
    event: 'PLAYER_DISCONNECTED',
  },
  PLAYER_DAMAGED: {
    raw: `[${SQUAD_TIME}][414]LogSquad: Player: Ivan ActualDamage=32.0 from Sergei …`,
    time: SQUAD_TIME,
    chainID: '414',
    victimName: 'Ivan',
    damage: 32,
    attackerName: 'Sergei',
    attackerEOSID: EOS_A,
    attackerSteamID: STEAM_A,
    attackerController: 'BP_PlayerController_C_2147481234',
    weapon: 'BP_M4A1',
    event: 'PLAYER_DAMAGED',
  },
  PLAYER_DIED: {
    raw: `[${SQUAD_TIME}][415]LogSquadTrace: [DedicatedServer]ASQSoldier::Die(): Player:Ivan …`,
    time: SQUAD_TIME,
    woundTime: SQUAD_TIME,
    chainID: '415',
    victimName: 'Ivan',
    damage: 100,
    attackerPlayerController: 'BP_PlayerController_C_2147481234',
    attackerEOSID: EOS_A,
    attackerSteamID: STEAM_A,
    weapon: 'BP_M4A1_C',
    event: 'PLAYER_DIED',
  },
  PLAYER_WOUNDED: {
    raw: `[${SQUAD_TIME}][416]LogSquadTrace: [DedicatedServer]ASQSoldier::Wound(): Player:Ivan …`,
    time: SQUAD_TIME,
    chainID: '416',
    victimName: 'Ivan',
    damage: 100,
    attackerPlayerController: 'BP_PlayerController_C_2147481234',
    attackerEOSID: EOS_A,
    attackerSteamID: STEAM_A,
    weapon: 'BP_M4A1',
    event: 'PLAYER_WOUNDED',
  },
  PLAYER_REVIVED: {
    raw: `[${SQUAD_TIME}][417]LogSquad: Sergei (…) has revived Ivan (…).`,
    time: SQUAD_TIME,
    chainID: '417',
    reviverName: 'Sergei',
    reviverEOSID: EOS_A,
    reviverSteamID: STEAM_A,
    victimName: 'Ivan',
    victimEOSID: EOS_B,
    victimSteamID: STEAM_B,
    event: 'PLAYER_REVIVED',
  },
  PLAYER_POSSESS: {
    raw: `[${SQUAD_TIME}][418]LogSquadTrace: [DedicatedServer]ASQPlayerController::OnPossess(): PC=Sergei …`,
    time: SQUAD_TIME,
    chainID: '418',
    name: 'Sergei',
    eosID: EOS_A,
    steamID: STEAM_A,
    possessClassname: 'BP_Soldier_RU_Rifleman',
    pawn: 'BP_Soldier_RU_Rifleman_C_2147480000',
    event: 'PLAYER_POSSESS',
  },
  PLAYER_UNPOSSESS: {
    raw: `[${SQUAD_TIME}][419]LogSquadTrace: [DedicatedServer]ASQPlayerController::OnUnPossess(): PC=Sergei …`,
    time: SQUAD_TIME,
    chainID: '419',
    name: 'Sergei',
    eosID: EOS_A,
    steamID: STEAM_A,
    event: 'PLAYER_UNPOSSESS',
  },
  NEW_GAME: {
    raw: `[${SQUAD_TIME}][420]LogWorld: Bringing World /Game/Maps/Yehorivka/Gameplay_Layers/Yehorivka_RAAS_v1.Yehorivka_RAAS_v1 …`,
    time: SQUAD_TIME,
    chainID: '420',
    dlc: 'Game',
    mapClassname: 'Yehorivka',
    layerClassname: 'Yehorivka_RAAS_v1',
    event: 'NEW_GAME',
  },
  ROUND_ENDED: {
    raw: `[${SQUAD_TIME}][421]LogGameState: Match State Changed from InProgress to WaitingPostMatch`,
    time: SQUAD_TIME,
    chainID: '421',
    event: 'ROUND_ENDED',
  },
  SQUAD_CREATED: {
    raw: `[${SQUAD_TIME}][422]LogSquad: Sergei (…) has created Squad 3 (Squad Name: Alpha) on Russian Ground Forces`,
    time: SQUAD_TIME,
    chainID: '422',
    name: 'Sergei',
    eosID: EOS_A,
    steamID: STEAM_A,
    squadID: '3',
    squadName: 'Alpha',
    teamName: 'Russian Ground Forces',
    event: 'SQUAD_CREATED',
  },
  DEPLOYABLE_DAMAGED: {
    raw: `[${SQUAD_TIME}][423]LogSquadTrace: [DedicatedServer]ASQDeployable::TakeDamage(): …`,
    time: SQUAD_TIME,
    chainID: '423',
    deployable: 'BP_FOBRadio_Woodland_C_2147470000',
    damage: 100,
    weapon: 'BP_Projectile_C_2147460000',
    name: 'Sergei',
    eosID: EOS_A,
    steamID: STEAM_A,
    healthRemaining: '900.0',
    event: 'DEPLOYABLE_DAMAGED',
  },
  TICK_RATE: {
    raw: `[${SQUAD_TIME}][424]LogSquad: USQGameState: Server Tick Rate: 39.2`,
    time: SQUAD_TIME,
    chainID: '424',
    tickRate: 39.2,
    event: 'TICK_RATE',
  },
  ADMIN_BROADCAST: {
    raw: `[${SQUAD_TIME}][425]LogSquad: ADMIN COMMAND: Message broadcasted <gg> from RCON`,
    time: SQUAD_TIME,
    chainID: '425',
    message: 'gg',
    from: 'RCON',
    event: 'ADMIN_BROADCAST',
  },
  CHAT_MESSAGE: {
    raw: `[ChatAll] [Online IDs:EOS: ${EOS_A} steam: ${STEAM_A}] Sergei : hi`,
    chat: 'ChatAll',
    eosID: EOS_A,
    steamID: STEAM_A,
    name: 'Sergei',
    message: 'hi',
    time: new Date(SQUAD_TIME_ISO),
  },
  POSSESSED_ADMIN_CAMERA: {
    raw: `[Online Ids:EOS: ${EOS_A} steam: ${STEAM_A}] Sergei has possessed admin camera.`,
    eosID: EOS_A,
    steamID: STEAM_A,
    name: 'Sergei',
    time: new Date(SQUAD_TIME_ISO),
  },
  UNPOSSESSED_ADMIN_CAMERA: {
    raw: `[Online IDs:EOS: ${EOS_A} steam: ${STEAM_A}] Sergei has unpossessed admin camera.`,
    eosID: EOS_A,
    steamID: STEAM_A,
    name: 'Sergei',
    time: new Date(SQUAD_TIME_ISO),
  },
} satisfies Record<string, Record<string, unknown>>;

describe('mapEvent', () => {
  it('maps an upstream PLAYER_CONNECTED to a schema-valid player.connected envelope', () => {
    const envelope = mapEvent(SERVER_ID, 'PLAYER_CONNECTED', RAW.PLAYER_CONNECTED, findPlayer);
    expect(envelope).toMatchObject({
      version: 1,
      type: 'player.connected',
      server_id: SERVER_ID,
      ts: SQUAD_TIME_ISO,
      actor: { kind: 'system', id: null },
      correlation_id: null,
      payload: { steam_id64: STEAM_A, eos_id: EOS_A, name: 'Sergei', ip: null },
    });
    expect(envelope?.event_id).toMatch(UUID_V7);
    expect(envelope && isPublishablePayload(envelope)).toBe(true);
  });

  it('resolves the steam id of a PLAYER_DISCONNECTED from its (upper-case) EOS id', () => {
    const envelope = mapEvent(
      SERVER_ID,
      'PLAYER_DISCONNECTED',
      RAW.PLAYER_DISCONNECTED,
      findPlayer,
    );
    expect(envelope?.type).toBe('player.disconnected');
    expect(envelope?.ts).toBe(SQUAD_TIME_ISO);
    expect(envelope?.payload).toEqual({ steam_id64: STEAM_A, eos_id: EOS_A, reason: null });
    expect(envelope && isPublishablePayload(envelope)).toBe(true);
  });

  it('leaves identity fields empty when the player is unknown, and flags the payload unpublishable', () => {
    const connected = mapEvent(
      SERVER_ID,
      'PLAYER_CONNECTED',
      RAW.PLAYER_CONNECTED,
      () => undefined,
    );
    expect(connected?.payload).toEqual({
      steam_id64: STEAM_A,
      eos_id: EOS_A,
      name: null,
      ip: null,
    });
    expect(connected && isPublishablePayload(connected)).toBe(false);

    const disconnected = mapEvent(SERVER_ID, 'PLAYER_DISCONNECTED', RAW.PLAYER_DISCONNECTED);
    expect(disconnected?.payload).toEqual({ steam_id64: null, eos_id: EOS_A, reason: null });
    expect(disconnected && isPublishablePayload(disconnected)).toBe(false);
  });

  it('parses the Squad log time format as UTC', () => {
    const envelope = mapEvent(SERVER_ID, 'ROUND_ENDED', { time: '2026.12.31-23.59.59:001' });
    expect(envelope?.ts).toBe('2026-12-31T23:59:59.001Z');
  });

  it('normalizes a Date time into a full ISO datetime string', () => {
    const envelope = mapEvent(SERVER_ID, 'ADMIN_BROADCAST', {
      message: 'gg',
      time: new Date('2026-04-24T10:00:00.000Z'),
    });
    expect(envelope?.ts).toBe('2026-04-24T10:00:00.000Z');
  });

  it.each(['not-a-date', '2026.13.40-25.61.61:000'])(
    'falls back to current ISO time when raw.time is %s',
    (time) => {
      const before = Date.now();
      const envelope = mapEvent(SERVER_ID, 'ADMIN_BROADCAST', { message: 'gg', time });
      const ts = Date.parse(envelope?.ts ?? '');
      expect(Number.isNaN(ts)).toBe(false);
      expect(ts).toBeGreaterThanOrEqual(before - 1000);
    },
  );

  it('returns null for unknown RNSquadJS event types', () => {
    expect(mapEvent(SERVER_ID, 'UNKNOWN_THING', {})).toBeNull();
  });

  const CASES: Array<[keyof typeof RAW, string, Record<string, unknown>]> = [
    [
      'PLAYER_DAMAGED',
      'player.damaged',
      { attacker: 'Sergei', victim: 'Ivan', weapon: 'BP_M4A1', damage: 32 },
    ],
    ['PLAYER_DIED', 'player.died', { attacker: 'Sergei', victim: 'Ivan', weapon: 'BP_M4A1_C' }],
    ['PLAYER_WOUNDED', 'player.wounded', { attacker: 'Sergei', victim: 'Ivan', weapon: 'BP_M4A1' }],
    ['PLAYER_REVIVED', 'player.revived', { reviver: 'Sergei', revived: 'Ivan' }],
    ['PLAYER_POSSESS', 'player.possess', { player: 'Sergei', vehicle: 'BP_Soldier_RU_Rifleman' }],
    ['PLAYER_UNPOSSESS', 'player.unpossess', { player: 'Sergei' }],
    ['NEW_GAME', 'match.started', { from_state: 'WaitingToStart', to_state: 'InProgress' }],
    ['ROUND_ENDED', 'match.ended', { from_state: 'InProgress', to_state: 'WaitingPostMatch' }],
    [
      'SQUAD_CREATED',
      'squad.created',
      { player: 'Sergei', squad_id: '3', squad_name: 'Alpha', team: 'Russian Ground Forces' },
    ],
    [
      'DEPLOYABLE_DAMAGED',
      'deployable.damaged',
      { deployable: 'BP_FOBRadio_Woodland_C_2147470000', damage: 100, attacker: 'Sergei' },
    ],
    ['TICK_RATE', 'server.tick_rate', { tick_rate: 39.2 }],
    ['ADMIN_BROADCAST', 'admin.broadcast', { message: 'gg' }],
    [
      'CHAT_MESSAGE',
      'chat.message',
      { channel: 'ChatAll', steam_id: STEAM_A, name: 'Sergei', message: 'hi' },
    ],
    ['POSSESSED_ADMIN_CAMERA', 'admin.camera_entered', { player: 'Sergei' }],
    ['UNPOSSESSED_ADMIN_CAMERA', 'admin.camera_left', { player: 'Sergei' }],
  ];

  it.each(CASES)('maps upstream %s', (rnType, expectedType, expectedPayload) => {
    const envelope = mapEvent(SERVER_ID, rnType, RAW[rnType], findPlayer);
    expect(envelope).not.toBeNull();
    expect(envelope?.type).toBe(expectedType);
    expect(envelope?.payload).toEqual(expectedPayload);
    expect(envelope?.ts).toBe(SQUAD_TIME_ISO);
    expect(envelope?.server_id).toBe(SERVER_ID);
    expect(envelope?.actor).toEqual({ kind: 'system', id: null });
    expect(envelope?.correlation_id).toBeNull();
    expect(envelope?.event_id).toMatch(UUID_V7);
  });
});

describe('isPublishablePayload', () => {
  const envelopeOf = (type: string, payload: Record<string, unknown>) => ({ type, payload });

  it('accepts payload-free match transitions and types without a strict schema', () => {
    expect(
      isPublishablePayload(
        envelopeOf('match.started', { from_state: 'WaitingToStart', to_state: 'InProgress' }),
      ),
    ).toBe(true);
    expect(isPublishablePayload(envelopeOf('server.tick_rate', { tick_rate: 39.2 }))).toBe(true);
  });

  it.each([
    ['a malformed steam id', { steam_id64: '123', eos_id: EOS_A, name: 'Sergei', ip: null }],
    [
      'an upper-case EOS id',
      { steam_id64: STEAM_A, eos_id: EOS_A.toUpperCase(), name: 'S', ip: null },
    ],
    ['an empty name', { steam_id64: STEAM_A, eos_id: EOS_A, name: '', ip: null }],
    ['a 129-char name', { steam_id64: STEAM_A, eos_id: EOS_A, name: 'x'.repeat(129), ip: null }],
  ])('rejects player.connected with %s', (_label, payload) => {
    expect(isPublishablePayload(envelopeOf('player.connected', payload))).toBe(false);
  });

  it('accepts player.connected with a null EOS id, as the shared schema does', () => {
    expect(
      isPublishablePayload(
        envelopeOf('player.connected', { steam_id64: STEAM_A, eos_id: null, name: 'S', ip: null }),
      ),
    ).toBe(true);
  });
});
