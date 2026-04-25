import { describe, expect, it, vi } from 'vitest';
import { redisSinkStream } from '../src/log-stream-sink.js';

interface XaddCall {
  stream: string;
  args: unknown[];
}

function fakeRedis(): { calls: XaddCall[]; xadd: (...a: unknown[]) => Promise<string> } {
  const calls: XaddCall[] = [];
  return {
    calls,
    xadd: async (...args: unknown[]) => {
      const [stream, ...rest] = args;
      calls.push({ stream: String(stream), args: rest });
      return '0-0';
    },
  };
}

describe('redisSinkStream', () => {
  it('encodes a pino info line into XADD fields', async () => {
    const r = fakeRedis();
    const stream = redisSinkStream({ redis: r as never, defaultSource: 'api' });
    stream.write(`${JSON.stringify({ level: 30, msg: 'rate-limit', extra: 1 })}\n`);
    stream.end();
    await new Promise<void>((resolve) => stream.on('finish', resolve));
    expect(r.calls).toHaveLength(1);
    expect(r.calls[0].stream).toBe('panel:logs');
    const flat = r.calls[0].args.flat();
    expect(flat).toContain('MAXLEN');
    expect(flat).toContain('100000');
    expect(flat).toContain('*');
    expect(flat).toContain('A');
    expect(flat).toContain('I');
    expect(flat).toContain('rate-limit');
  });

  it('routes to a per-record source if "src" field is set in the log', async () => {
    const r = fakeRedis();
    const stream = redisSinkStream({ redis: r as never, defaultSource: 'api' });
    stream.write(`${JSON.stringify({ level: 40, msg: 'down', src: 'bridge' })}\n`);
    stream.end();
    await new Promise<void>((resolve) => stream.on('finish', resolve));
    const flat = r.calls[0].args.flat();
    expect(flat).toContain('B');
  });

  it('attaches serverId from log payload', async () => {
    const r = fakeRedis();
    const stream = redisSinkStream({ redis: r as never, defaultSource: 'rcon' });
    stream.write(
      `${JSON.stringify({ level: 30, msg: 'auth ok', serverId: '01999999-9999-7999-8999-999999999999' })}\n`,
    );
    stream.end();
    await new Promise<void>((resolve) => stream.on('finish', resolve));
    const flat = r.calls[0].args.flat();
    expect(flat).toContain('01999999-9999-7999-8999-999999999999');
  });

  it('swallows redis errors without throwing', async () => {
    const xaddErr = vi.fn(async () => {
      throw new Error('boom');
    });
    const stream = redisSinkStream({
      redis: { xadd: xaddErr } as never,
      defaultSource: 'api',
    });
    stream.write(`${JSON.stringify({ level: 30, msg: 'x' })}\n`);
    stream.end();
    await new Promise<void>((resolve) => stream.on('finish', resolve));
    expect(xaddErr).toHaveBeenCalledTimes(1);
  });

  it('skips lines below the configured minimum level', async () => {
    const r = fakeRedis();
    const stream = redisSinkStream({ redis: r as never, defaultSource: 'api', minLevel: 'warn' });
    stream.write(`${JSON.stringify({ level: 30, msg: 'info-line' })}\n`);
    stream.write(`${JSON.stringify({ level: 40, msg: 'warn-line' })}\n`);
    stream.end();
    await new Promise<void>((resolve) => stream.on('finish', resolve));
    expect(r.calls).toHaveLength(1);
    expect(r.calls[0].args.flat()).toContain('warn-line');
  });
});
