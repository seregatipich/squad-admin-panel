import { describe, expect, it, vi } from 'vitest';
import { createDiag } from '../src/index.js';

describe('diag.emit', () => {
  it('XADDs the event to diag:queue with all fields serialized', async () => {
    const xadd = vi.fn().mockResolvedValue('1700000000000-0');
    const redis = { xadd } as never;
    const log = { warn: vi.fn(), debug: vi.fn() } as never;
    const diag = createDiag({ redis, log });

    await diag.emit({
      component: 'api',
      kind: 'server.start.requested',
      severity: 'info',
      serverId: '019dbaa5-0000-7000-8000-000000000000',
      message: 'manual start',
      payload: { reason: 'manual' },
    });

    expect(xadd).toHaveBeenCalledTimes(1);
    const args = xadd.mock.calls[0]!;
    expect(args[0]).toBe('diag:queue');
    expect(args).toContain('MAXLEN');
    const flat = args.slice(args.indexOf('*') + 1) as string[];
    const fields: Record<string, string> = {};
    for (let i = 0; i < flat.length; i += 2) fields[flat[i]!] = flat[i + 1]!;
    expect(fields.component).toBe('api');
    expect(fields.kind).toBe('server.start.requested');
    expect(JSON.parse(fields.payload!)).toEqual({ reason: 'manual' });
  });

  it('falls back to pino.warn when Redis throws', async () => {
    const redis = { xadd: vi.fn().mockRejectedValue(new Error('NOREDIS')) } as never;
    const log = { warn: vi.fn(), debug: vi.fn() } as never;
    const diag = createDiag({ redis, log });
    await diag.emit({ component: 'api', kind: 'x', severity: 'info', message: 'hi' });
    expect(log.warn).toHaveBeenCalled();
    const arg = (log.warn as ReturnType<typeof vi.fn>).mock.calls[0]![0] as {
      diag_event: { kind: string };
    };
    expect(arg.diag_event.kind).toBe('x');
  });
});
