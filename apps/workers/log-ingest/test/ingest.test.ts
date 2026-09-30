import { describe, expect, it } from 'vitest';
import { LogIngestor } from '../src/parser/ingest.js';

const SERVER_ID = 'test-server-id';

describe('LogIngestor – player connect/disconnect flow', () => {
  it('emits player.connected when EOS line follows join within correlation window', () => {
    const ing = new LogIngestor({
      serverId: SERVER_ID,
      beaconPort: 15000,
      joinCorrelationWindowMs: 2500,
    });

    ing.ingest('[2026.04.23-11.30.00:000][0]LogNet: Join succeeded: PlayerName123');
    const events = ing.ingest(
      '[2026.04.23-11.30.00:100][0]LogRedpointEOS: EOSNet VoiceChat EOS:abcdef1234567890abcdef1234567890 Steam:76561198012345678',
    );
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe('player.connected');
    expect((events[0]?.payload as Record<string, unknown>).steam_id64).toBe('76561198012345678');
    expect((events[0]?.payload as Record<string, unknown>).ip).toBeNull();
  });

  // Regression for #63 finding 931: two connects racing through the same
  // window used to cross-assign IP/name/EOS via single-slot "most recent"
  // correlation. FIFO pairing must keep each connect's own lines together.
  it('keeps two interleaved simultaneous connects paired instead of cross-assigning IP/EOS/name', () => {
    const ing = new LogIngestor({
      serverId: SERVER_ID,
      beaconPort: 15000,
      joinCorrelationWindowMs: 2500,
    });

    ing.ingest(
      '[2026.04.23-11.30.00:000][0]LogNet: AddClientConnection: Added client connection: [UNetConnection] RemoteAddr: 203.0.113.10:7787, Name: EOSIpNetConnection_1, Driver: GameNetDriver EOSNetDriver_1, IsServer: YES, PC: NULL, Owner: NULL, UniqueId: INVALID',
    );
    ing.ingest(
      '[2026.04.23-11.30.00:010][0]LogNet: AddClientConnection: Added client connection: [UNetConnection] RemoteAddr: 203.0.113.20:7787, Name: EOSIpNetConnection_2, Driver: GameNetDriver EOSNetDriver_2, IsServer: YES, PC: NULL, Owner: NULL, UniqueId: INVALID',
    );
    ing.ingest('[2026.04.23-11.30.00:020][0]LogNet: Join succeeded: PlayerA');
    ing.ingest('[2026.04.23-11.30.00:030][0]LogNet: Join succeeded: PlayerB');
    const eventsA = ing.ingest(
      '[2026.04.23-11.30.00:040][0]LogRedpointEOS: EOSNet VoiceChat EOS:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa Steam:76561198000000001',
    );
    const eventsB = ing.ingest(
      '[2026.04.23-11.30.00:050][0]LogRedpointEOS: EOSNet VoiceChat EOS:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb Steam:76561198000000002',
    );

    expect(eventsA).toHaveLength(1);
    expect(eventsB).toHaveLength(1);
    const payloadA = eventsA[0]?.payload as Record<string, unknown>;
    const payloadB = eventsB[0]?.payload as Record<string, unknown>;
    expect(payloadA).toMatchObject({
      name: 'PlayerA',
      ip: '203.0.113.10',
      steam_id64: '76561198000000001',
    });
    expect(payloadB).toMatchObject({
      name: 'PlayerB',
      ip: '203.0.113.20',
      steam_id64: '76561198000000002',
    });
  });

  it('emits player.connected with the real IP when AddClientConnection correlates before the join', () => {
    const ing = new LogIngestor({
      serverId: SERVER_ID,
      beaconPort: 15000,
      joinCorrelationWindowMs: 2500,
    });

    ing.ingest(
      '[2026.04.23-11.29.59:900][0]LogNet: AddClientConnection: Added client connection: [UNetConnection] RemoteAddr: 203.0.113.42:7787, Name: EOSIpNetConnection_2147483647, Driver: GameNetDriver EOSNetDriver_2147483646, IsServer: YES, PC: NULL, Owner: NULL, UniqueId: INVALID',
    );
    ing.ingest('[2026.04.23-11.30.00:000][0]LogNet: Join succeeded: IpPlayer');
    const events = ing.ingest(
      '[2026.04.23-11.30.00:100][0]LogRedpointEOS: EOSNet VoiceChat EOS:abcdef1234567890abcdef1234567890 Steam:76561198012345678',
    );

    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe('player.connected');
    expect((events[0]?.payload as Record<string, unknown>).ip).toBe('203.0.113.42');
  });

  it('leaves player.connected ip null when no AddClientConnection line precedes the join', () => {
    const ing = new LogIngestor({
      serverId: SERVER_ID,
      beaconPort: 15000,
      joinCorrelationWindowMs: 2500,
    });

    ing.ingest('[2026.04.23-11.30.00:000][0]LogNet: Join succeeded: NoIpPlayer');
    const events = ing.ingest(
      '[2026.04.23-11.30.00:100][0]LogRedpointEOS: EOSNet VoiceChat EOS:abcdef1234567890abcdef1234567890 Steam:76561198012345678',
    );

    expect(events).toHaveLength(1);
    expect((events[0]?.payload as Record<string, unknown>).ip).toBeNull();
  });

  it('leaves player.connected ip null when the AddClientConnection line is outside the correlation window', () => {
    const ing = new LogIngestor({
      serverId: SERVER_ID,
      beaconPort: 15000,
      joinCorrelationWindowMs: 100,
    });

    ing.ingest(
      '[2026.04.23-11.29.55:000][0]LogNet: AddClientConnection: Added client connection: [UNetConnection] RemoteAddr: 198.51.100.7:7787, Name: EOSIpNetConnection_1, Driver: GameNetDriver EOSNetDriver_1, IsServer: YES, PC: NULL, Owner: NULL, UniqueId: INVALID',
    );
    ing.ingest('[2026.04.23-11.30.00:000][0]LogNet: Join succeeded: StalePlayer');
    const events = ing.ingest(
      '[2026.04.23-11.30.00:050][0]LogRedpointEOS: EOSNet VoiceChat EOS:abcdef1234567890abcdef1234567890 Steam:76561198012345679',
    );

    expect(events).toHaveLength(1);
    expect((events[0]?.payload as Record<string, unknown>).ip).toBeNull();
  });

  it('leaves player.connected ip null for the Steam-driver AddClientConnection variant (no real IP)', () => {
    const ing = new LogIngestor({
      serverId: SERVER_ID,
      beaconPort: 15000,
      joinCorrelationWindowMs: 2500,
    });

    ing.ingest(
      '[2026.04.23-11.29.59:900][0]LogNet: AddClientConnection: Added client connection: [UNetConnection] RemoteAddr: 76561198012345678:0, Name: SteamNetConnection_1, Driver: GameNetDriver SteamNetDriver_1, IsServer: YES, PC: NULL, Owner: NULL, UniqueId: INVALID',
    );
    ing.ingest('[2026.04.23-11.30.00:000][0]LogNet: Join succeeded: SteamOnlyPlayer');
    const events = ing.ingest(
      '[2026.04.23-11.30.00:100][0]LogRedpointEOS: EOSNet VoiceChat EOS:abcdef1234567890abcdef1234567890 Steam:76561198012345680',
    );

    expect(events).toHaveLength(1);
    expect((events[0]?.payload as Record<string, unknown>).ip).toBeNull();
  });

  it('does not emit player.connected when EOS line arrives after correlation window', () => {
    const ing = new LogIngestor({
      serverId: SERVER_ID,
      beaconPort: 15000,
      joinCorrelationWindowMs: 100,
    });

    ing.ingest('[2026.04.23-11.30.00:000][0]LogNet: Join succeeded: SlowPlayer');
    const events = ing.ingest(
      '[2026.04.23-11.30.01:000][0]LogRedpointEOS: EOSNet EOS:abcdef1234567890abcdef1234567890 Steam:76561198000000001',
    );
    expect(events).toHaveLength(0);
  });

  it('emits player.disconnected with steam_id64', () => {
    const ing = new LogIngestor({ serverId: SERVER_ID, beaconPort: 15000 });
    const events = ing.ingest(
      '[2026.04.23-11.35.00:000][0]LogNet: UChannel::Close: Sending CloseBunch UniqueId: EOS:abcdef1234567890abcdef1234567890|STEAM:76561198012345678',
    );
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe('player.disconnected');
    expect((events[0]?.payload as Record<string, unknown>).steam_id64).toBe('76561198012345678');
  });

  it('emits rcon.admin_command (not rcon.connected) on ADMIN COMMAND log line', () => {
    const ing = new LogIngestor({ serverId: SERVER_ID, beaconPort: 15000 });
    const events = ing.ingest(
      '[2026.04.23-11.30.00:000][0]LogSquad: ADMIN COMMAND: ListPlayers from RCON',
    );
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe('rcon.admin_command');
  });

  it('emits a stable event_id when the same log line is replayed', () => {
    const line = '[2026.04.23-11.30.00:000][0]LogSquad: ADMIN COMMAND: ListPlayers from RCON';
    const first = new LogIngestor({ serverId: SERVER_ID, beaconPort: 15000 }).ingest(line);
    const replay = new LogIngestor({ serverId: SERVER_ID, beaconPort: 15000 }).ingest(line);

    expect(first).toHaveLength(1);
    expect(replay).toHaveLength(1);
    expect(replay[0]?.event_id).toBe(first[0]?.event_id);
  });

  it('returns empty array for unrecognised log lines', () => {
    const ing = new LogIngestor({ serverId: SERVER_ID, beaconPort: 15000 });
    const events = ing.ingest(
      '[2026.04.23-11.30.00:000][0]LogSomething: Random noise that matches nothing',
    );
    expect(events).toHaveLength(0);
  });
});
