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
});
