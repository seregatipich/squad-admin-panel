import type { DatabaseClient } from '@squad/db';
import type Redis from 'ioredis';
import { describe, expect, it, vi } from 'vitest';
import { notifyReporter } from '../src/lib/report-notify.js';

const OPTS = {
  serverId: 'srv-1',
  reporterPlayerId: 'player-1',
  template: 'resolved' as const,
  actorPlayerId: null,
};

function dbReturning(rows: unknown[] | Error): DatabaseClient {
  const limit =
    rows instanceof Error ? vi.fn().mockRejectedValue(rows) : vi.fn().mockResolvedValue(rows);
  return {
    select: () => ({ from: () => ({ where: () => ({ limit }) }) }),
  } as unknown as DatabaseClient;
}

describe('notifyReporter keeps its "never throws" contract (#66)', () => {
  it('reports a database failure as an outcome', async () => {
    const redis = { get: vi.fn() } as unknown as Redis;
    const outcome = await notifyReporter(dbReturning(new Error('db down')), redis, OPTS);
    expect(outcome).toEqual({ attempted: false, notified: false, reason: 'lookup_failed' });
  });

  it('reports a Redis failure on the roster read as an outcome', async () => {
    const db = dbReturning([{ id: 'player-1', eosId: 'eos-1', steamId64: 76561198000000001n }]);
    const redis = { get: vi.fn().mockRejectedValue(new Error('redis down')) } as unknown as Redis;
    const outcome = await notifyReporter(db, redis, OPTS);
    expect(outcome).toEqual({ attempted: false, notified: false, reason: 'lookup_failed' });
  });

  it('reports a Redis failure inside the worker handoff as worker_unavailable', async () => {
    const db = dbReturning([{ id: 'player-1', eosId: 'eos-1', steamId64: 76561198000000001n }]);
    const roster = JSON.stringify({ players: [{ eos_id: 'eos-1', steam_id64: null }] });
    const redis = {
      get: vi.fn((key: string) =>
        key.startsWith('rcon:roster:')
          ? Promise.resolve(roster)
          : Promise.reject(new Error('down')),
      ),
    } as unknown as Redis;
    const outcome = await notifyReporter(db, redis, OPTS);
    expect(outcome).toEqual({ attempted: true, notified: false, reason: 'worker_unavailable' });
  });
});
