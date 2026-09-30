import { seedSubscriptions } from '@squad/db/schema';
import { describe, expect, it, vi } from 'vitest';
import { notifySeedSubscribers } from '../src/seed-notifications.js';

function makeDb(
  subscriptions: Array<{ playerId: string; channel: string }>,
  rules: Array<{ id: string; config: Record<string, unknown>; channels: string[] }>,
  inserted: Array<Record<string, unknown>>[],
) {
  const select = vi.fn((selection: Record<string, unknown>) => ({
    from: vi.fn(() => ({
      where: vi.fn(async () =>
        selection.playerId === seedSubscriptions.playerId ? subscriptions : rules,
      ),
    })),
  }));
  return {
    select,
    insert: vi.fn(() => ({
      values: vi.fn(async (values: Array<Record<string, unknown>>) => {
        inserted.push(values);
      }),
    })),
  } as never;
}

describe('notifySeedSubscribers', () => {
  it('materializes only subscribed channels for a matching enabled AUTO-3 rule', async () => {
    const inserted: Array<Record<string, unknown>>[] = [];
    const db = makeDb(
      [{ playerId: 'player-1', channel: 'webpush' }],
      [{ id: 'rule-seed', config: { eventKind: 'seed.call_sent' }, channels: ['webpush'] }],
      inserted,
    );
    const redis = { publish: vi.fn().mockResolvedValue(1) };

    const notified = await notifySeedSubscribers(db, redis, {
      serverId: 'server-1',
      eventKind: 'seed.call_sent',
      payload: {
        server_name: 'RU #1',
        join_link: 'steam://connect/10.0.0.1:27015',
      },
    });

    expect(notified).toBe(1);
    expect(inserted).toEqual([
      [
        expect.objectContaining({
          ruleId: 'rule-seed',
          severity: 'info',
          payload: expect.objectContaining({
            player_id: 'player-1',
            channel: 'webpush',
            event_kind: 'seed.call_sent',
          }),
        }),
      ],
    ]);
    expect(redis.publish).toHaveBeenCalledWith(
      'live-bus',
      expect.stringContaining('alert.triggered'),
    );
  });

  it('inserts every matching subscription in a single batched call, not one per row', async () => {
    const inserted: Array<Record<string, unknown>>[] = [];
    const db = makeDb(
      [
        { playerId: 'player-1', channel: 'webpush' },
        { playerId: 'player-2', channel: 'webpush' },
      ],
      [{ id: 'rule-seed', config: { eventKind: 'seed.call_sent' }, channels: ['webpush'] }],
      inserted,
    );
    const redis = { publish: vi.fn().mockResolvedValue(1) };

    const notified = await notifySeedSubscribers(db, redis, {
      serverId: 'server-1',
      eventKind: 'seed.call_sent',
      payload: { server_name: 'RU #1' },
    });

    expect(notified).toBe(2);
    // A single insert() call carrying both rows, not two separate calls.
    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toHaveLength(2);
  });

  it('emits at most one alert event per subscription even when two enabled rules match', async () => {
    const inserted: Array<Record<string, unknown>>[] = [];
    const db = makeDb(
      [{ playerId: 'player-1', channel: 'webpush' }],
      [
        { id: 'rule-a', config: { eventKind: 'seed.call_sent' }, channels: ['webpush'] },
        { id: 'rule-b', config: { eventKind: 'seed.call_sent' }, channels: ['webpush'] },
      ],
      inserted,
    );
    const redis = { publish: vi.fn().mockResolvedValue(1) };

    const notified = await notifySeedSubscribers(db, redis, {
      serverId: 'server-1',
      eventKind: 'seed.call_sent',
      payload: { server_name: 'RU #1' },
    });

    expect(notified).toBe(1);
    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toHaveLength(1);
    expect(redis.publish).toHaveBeenCalledTimes(1);
  });
});
