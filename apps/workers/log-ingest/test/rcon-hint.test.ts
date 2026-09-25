import { parseRconRefreshHint, RCON_REFRESH_CHANNEL } from '@squad/shared-config';
import { describe, expect, it, vi } from 'vitest';
import { LogIngestor } from '../src/parser/ingest.js';
import { publishRconRefreshHint } from '../src/rcon-hint.js';

const SERVER_ID = '019dbac8-ceb0-77ab-859b-bfa9a282ee2c';

function fakeRedis() {
  return { publish: vi.fn().mockResolvedValue(1) };
}

function hintsSent(redis: ReturnType<typeof fakeRedis>) {
  return redis.publish.mock.calls.map(([channel, raw]) => ({
    channel,
    hint: parseRconRefreshHint(String(raw)),
  }));
}

describe('publishRconRefreshHint', () => {
  it('asks worker-rcon for a roster refresh the moment a join is parsed from the log', async () => {
    const ing = new LogIngestor({ serverId: SERVER_ID, beaconPort: 15000 });
    ing.ingest('[2026.04.23-11.30.00:000][0]LogNet: Join succeeded: PlayerName123');
    const [event] = ing.ingest(
      '[2026.04.23-11.30.00:100][0]LogRedpointEOS: EOSNet VoiceChat EOS:abcdef1234567890abcdef1234567890 Steam:76561198012345678',
    );
    expect(event?.type).toBe('player.connected');

    const redis = fakeRedis();
    await expect(publishRconRefreshHint(redis, event as never)).resolves.toBe(true);
    expect(hintsSent(redis)).toEqual([
      {
        channel: RCON_REFRESH_CHANNEL,
        hint: { server_id: SERVER_ID, scopes: ['roster'], reason: 'player.connected' },
      },
    ]);
  });

  it('asks for a roster refresh on a leave', async () => {
    const ing = new LogIngestor({ serverId: SERVER_ID, beaconPort: 15000 });
    const [event] = ing.ingest(
      '[2026.04.23-11.35.00:000][0]LogNet: UChannel::Close: Sending CloseBunch UniqueId: EOS:abcdef1234567890abcdef1234567890|STEAM:76561198012345678',
    );
    expect(event?.type).toBe('player.disconnected');

    const redis = fakeRedis();
    await publishRconRefreshHint(redis, event as never);
    expect(hintsSent(redis)[0]?.hint).toEqual({
      server_id: SERVER_ID,
      scopes: ['roster'],
      reason: 'player.disconnected',
    });
  });

  it('asks for roster and server info on a match boundary', async () => {
    const redis = fakeRedis();
    await publishRconRefreshHint(redis, { type: 'match.started', server_id: SERVER_ID });
    expect(hintsSent(redis)[0]?.hint?.scopes).toEqual(['roster', 'info']);
  });

  it('stays quiet for events RCON does not report and for global events', async () => {
    const redis = fakeRedis();
    await expect(
      publishRconRefreshHint(redis, { type: 'player.name_changed', server_id: SERVER_ID }),
    ).resolves.toBe(false);
    await expect(
      publishRconRefreshHint(redis, { type: 'player.connected', server_id: null }),
    ).resolves.toBe(false);
    expect(redis.publish).not.toHaveBeenCalled();
  });
});
