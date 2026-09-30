import { describe, expect, it, vi } from 'vitest';
import { flushBatch, parseEntry, reclaimPendingEntries } from '../src/index.js';

function fields(overrides: Record<string, string> = {}): string[] {
  const base: Record<string, string> = {
    id: '019dbaa5-0000-7000-8000-000000000001',
    ts: '2026-04-28T10:00:00Z',
    component: 'api',
    severity: 'info',
    kind: 'server.start.requested',
    message: 'manual',
    payload: '{}',
    ...overrides,
  };
  return Object.entries(base).flat();
}

function pgError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

describe('parseEntry validation (#872)', () => {
  it.each([
    ['id', 'not-a-uuid'],
    ['ts', 'yesterday'],
    ['severity', 'critical'],
    ['server_id', 'server-1'],
    ['actor_player_id', '42'],
    ['payload', '{not json'],
  ])('rejects an entry whose %s is %s', (key, value) => {
    expect(parseEntry(fields({ [key]: value }))).toBeNull();
  });

  it('accepts optional uuids and normalises the timestamp', () => {
    const parsed = parseEntry(
      fields({
        server_id: '019dbaa5-0000-7000-8000-0000000000aa',
        actor_player_id: '019dbaa5-0000-7000-8000-0000000000bb',
        ts: '2026-04-28T10:00:00+03:00',
      }),
    );
    expect(parsed).toMatchObject({
      serverId: '019dbaa5-0000-7000-8000-0000000000aa',
      actorPlayerId: '019dbaa5-0000-7000-8000-0000000000bb',
      ts: '2026-04-28T07:00:00.000Z',
    });
  });
});

describe('flushBatch poison-row isolation (#872)', () => {
  const entries: [string, string[]][] = [
    ['1-0', fields({ id: '019dbaa5-0000-7000-8000-000000000001' })],
    ['1-1', fields({ id: '019dbaa5-0000-7000-8000-000000000002' })],
    ['1-2', fields({ id: '019dbaa5-0000-7000-8000-000000000003' })],
  ];

  it('inserts the good rows one by one and acks everything when one row is rejected', async () => {
    const unsafe = vi
      .fn()
      .mockRejectedValueOnce(pgError('23514', 'no partition of relation found for row'))
      .mockResolvedValueOnce([])
      .mockRejectedValueOnce(pgError('23514', 'no partition of relation found for row'))
      .mockResolvedValueOnce([]);
    const xack = vi.fn().mockResolvedValue(3);

    await flushBatch({
      sql: { unsafe } as never,
      redis: { xack } as never,
      group: 'g',
      stream: 'diag:queue',
      entries,
    });

    expect(unsafe).toHaveBeenCalledTimes(4);
    expect(xack).toHaveBeenCalledWith('diag:queue', 'g', '1-0', '1-1', '1-2');
  });

  it('leaves the batch pending when the database is unreachable', async () => {
    const unsafe = vi.fn().mockRejectedValue(new Error('connect ECONNREFUSED'));
    const xack = vi.fn();

    await expect(
      flushBatch({
        sql: { unsafe } as never,
        redis: { xack } as never,
        group: 'g',
        stream: 'diag:queue',
        entries,
      }),
    ).rejects.toThrow('ECONNREFUSED');
    expect(xack).not.toHaveBeenCalled();
  });

  it('leaves the batch pending when the database drops while isolating rows', async () => {
    const unsafe = vi
      .fn()
      .mockRejectedValueOnce(pgError('22P02', 'invalid input syntax'))
      .mockRejectedValueOnce(new Error('connection terminated'));
    const xack = vi.fn();

    await expect(
      flushBatch({
        sql: { unsafe } as never,
        redis: { xack } as never,
        group: 'g',
        stream: 'diag:queue',
        entries,
      }),
    ).rejects.toThrow('connection terminated');
    expect(xack).not.toHaveBeenCalled();
  });
});

describe('reclaimPendingEntries (#872)', () => {
  it('flushes entries left pending by a failed batch or a dead consumer', async () => {
    const unsafe = vi.fn().mockResolvedValue([]);
    const xack = vi.fn().mockResolvedValue(1);
    const xautoclaim = vi
      .fn()
      .mockResolvedValueOnce(['2-0', [['1-0', fields()]], []])
      .mockResolvedValueOnce([
        '0-0',
        [['2-0', fields({ id: '019dbaa5-0000-7000-8000-000000000009' })]],
        [],
      ]);

    const flushed = await reclaimPendingEntries({
      sql: { unsafe } as never,
      redis: { xack, xautoclaim } as never,
      group: 'g',
      stream: 'diag:queue',
      consumer: 'c',
      minIdleMs: 60_000,
      batchSize: 100,
    });

    expect(flushed).toBe(2);
    expect(xautoclaim).toHaveBeenNthCalledWith(
      1,
      'diag:queue',
      'g',
      'c',
      60_000,
      '0-0',
      'COUNT',
      100,
    );
    expect(xautoclaim).toHaveBeenNthCalledWith(
      2,
      'diag:queue',
      'g',
      'c',
      60_000,
      '2-0',
      'COUNT',
      100,
    );
    expect(xack).toHaveBeenCalledTimes(2);
  });
});
