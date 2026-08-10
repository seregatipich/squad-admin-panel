import { describe, expect, it, vi } from 'vitest';
import { flushBatch } from '../src/index.js';

function makeSql() {
  const unsafe = vi.fn(async () => undefined);
  const sql = Object.assign((async () => undefined) as never, { unsafe }) as never;
  return { sql, unsafe };
}

describe('worker-diag-flush', () => {
  it('parses XREAD entries and inserts in one batch, then ACKs', async () => {
    const { sql, unsafe } = makeSql();
    const xack = vi.fn().mockResolvedValue(1);
    const redis = { xack } as never;

    const entries: [string, string[]][] = [
      [
        '1700-0',
        [
          'id',
          '019dbaa5-0000-7000-8000-000000000001',
          'ts',
          '2026-04-28T10:00:00Z',
          'component',
          'api',
          'severity',
          'info',
          'kind',
          'server.start.requested',
          'message',
          'manual',
          'payload',
          '{}',
        ],
      ],
    ];

    await flushBatch({ sql, redis, group: 'g', stream: 'diag:queue', entries });

    expect(unsafe).toHaveBeenCalledTimes(1);
    const call = unsafe.mock.calls[0];
    if (!call) throw new Error('expected unsafe to be called');
    const [text, args] = call;
    expect(text).toMatch(/^INSERT INTO diagnostic_events/);
    expect(text).toMatch(/ON CONFLICT \(id, ts\) DO NOTHING/);
    expect(args).toBeInstanceOf(Array);
    expect((args as unknown[])[0]).toBe('019dbaa5-0000-7000-8000-000000000001');
    expect(xack).toHaveBeenCalledWith('diag:queue', 'g', '1700-0');
  });

  it('skips malformed entries but ACKs them so they do not block the stream', async () => {
    const { sql, unsafe } = makeSql();
    const xack = vi.fn().mockResolvedValue(1);
    const redis = { xack } as never;

    const entries: [string, string[]][] = [['1700-0', ['not-a-valid-key', 'value']]];

    await flushBatch({ sql, redis, group: 'g', stream: 'diag:queue', entries });

    expect(unsafe).not.toHaveBeenCalled();
    expect(xack).toHaveBeenCalledWith('diag:queue', 'g', '1700-0');
  });

  it('inserts valid rows and still ACKs malformed ones in the same batch', async () => {
    const { sql, unsafe } = makeSql();
    const xack = vi.fn().mockResolvedValue(2);
    const redis = { xack } as never;

    const entries: [string, string[]][] = [
      ['1700-0', ['nope', 'broken']],
      [
        '1700-1',
        [
          'id',
          '019dbaa5-0000-7000-8000-000000000002',
          'ts',
          '2026-04-28T10:00:01Z',
          'component',
          'worker-rcon',
          'severity',
          'warn',
          'kind',
          'rcon.connect.failed',
          'server_id',
          '00000000-0000-0000-0000-000000000001',
          'request_id',
          'req-1',
          'message',
          'auth refused',
          'payload',
          '{"attempt":3}',
        ],
      ],
    ];

    await flushBatch({ sql, redis, group: 'g', stream: 'diag:queue', entries });

    expect(unsafe).toHaveBeenCalledTimes(1);
    const call = unsafe.mock.calls[0];
    if (!call) throw new Error('expected unsafe to be called');
    const [text, args] = call;
    expect(text).toMatch(/VALUES \(\$1,\$2::timestamptz,/);
    expect((args as unknown[]).length).toBe(10);
    expect(xack).toHaveBeenCalledWith('diag:queue', 'g', '1700-0', '1700-1');
  });

  it('returns immediately when entries is empty', async () => {
    const { sql, unsafe } = makeSql();
    const xack = vi.fn();
    const redis = { xack } as never;

    await flushBatch({ sql, redis, group: 'g', stream: 'diag:queue', entries: [] });

    expect(unsafe).not.toHaveBeenCalled();
    expect(xack).not.toHaveBeenCalled();
  });
});
