import { seedSubscriptions } from '@squad/db/schema';
import { describe, expect, it, vi } from 'vitest';
import { notifySeedSubscribers } from '../src/seed-notifications.js';

describe('notifySeedSubscribers', () => {
  it('materializes only subscribed channels for a matching enabled AUTO-3 rule', async () => {
    const inserted: Array<Record<string, unknown>> = [];
    const select = vi.fn((selection: Record<string, unknown>) => ({
      from: vi.fn(() => ({
        where: vi.fn(async () =>
          selection.playerId === seedSubscriptions.playerId
            ? [{ playerId: 'player-1', channel: 'webpush' }]
            : [
                {
                  id: 'rule-seed',
                  config: { eventKind: 'seed.call_sent' },
                  channels: ['webpush'],
                },
              ],
        ),
      })),
    }));
    const db = {
      select,
      insert: vi.fn(() => ({
        values: vi.fn(async (value: Record<string, unknown>) => {
          inserted.push(value);
        }),
      })),
    } as never;
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
      expect.objectContaining({
        ruleId: 'rule-seed',
        severity: 'info',
        payload: expect.objectContaining({
          player_id: 'player-1',
          channel: 'webpush',
          event_kind: 'seed.call_sent',
        }),
      }),
    ]);
    expect(redis.publish).toHaveBeenCalledWith(
      'live-bus',
      expect.stringContaining('alert.triggered'),
    );
  });
});
