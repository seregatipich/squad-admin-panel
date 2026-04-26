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

  it('emits rcon.connected on ADMIN COMMAND log line', () => {
    const ing = new LogIngestor({ serverId: SERVER_ID, beaconPort: 15000 });
    const events = ing.ingest(
      '[2026.04.23-11.30.00:000][0]LogSquad: ADMIN COMMAND: ListPlayers from RCON',
    );
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe('rcon.connected');
  });

  it('returns empty array for unrecognised log lines', () => {
    const ing = new LogIngestor({ serverId: SERVER_ID, beaconPort: 15000 });
    const events = ing.ingest(
      '[2026.04.23-11.30.00:000][0]LogSomething: Random noise that matches nothing',
    );
    expect(events).toHaveLength(0);
  });
});
