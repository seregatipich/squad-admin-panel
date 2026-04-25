import { describe, expect, it } from 'vitest';
import {
  decodeLogEntry,
  encodeLogEntry,
  LOG_LEVELS,
  LOG_SOURCES,
  type LogEntry,
  sourceCode,
  sourceFromCode,
} from '../src/log-stream.js';

describe('log-stream encoding', () => {
  it('encodes and decodes round-trip with all fields', () => {
    const entry: Omit<LogEntry, 'ts'> = {
      source: 'rcon',
      level: 'info',
      serverId: '01999999-9999-7999-8999-999999999999',
      msg: 'auth ok',
      ctx: { rttMs: 14 },
    };
    const fields = encodeLogEntry(entry);
    const decoded = decodeLogEntry('1735900000000-0', fields);
    expect(decoded).toEqual({ ts: 1735900000000, ...entry });
  });

  it('omits serverId and ctx when not provided', () => {
    const fields = encodeLogEntry({ source: 'bridge', level: 'debug', msg: 'alive rtt=2ms' });
    expect(fields).not.toHaveProperty('i');
    expect(fields).not.toHaveProperty('c');
    expect(fields.s).toBe('B');
    expect(fields.l).toBe('D');
    expect(fields.m).toBe('alive rtt=2ms');
  });

  it('round-trips an entry without optional fields', () => {
    const fields = encodeLogEntry({ source: 'api', level: 'warn', msg: 'rate-limit' });
    const decoded = decodeLogEntry('1700000000000-0', fields);
    expect(decoded.serverId).toBeUndefined();
    expect(decoded.ctx).toBeUndefined();
    expect(decoded.source).toBe('api');
    expect(decoded.level).toBe('warn');
  });

  it('throws on unknown source code', () => {
    expect(() => decodeLogEntry('1-0', { s: 'Z', l: 'I', m: 'x' })).toThrow(/source/);
  });

  it('exposes stable source codes', () => {
    expect(sourceCode('bridge')).toBe('B');
    expect(sourceCode('rcon')).toBe('R');
    expect(sourceFromCode('L')).toBe('log-ingest');
    expect(LOG_SOURCES).toEqual([
      'bridge',
      'rcon',
      'log-ingest',
      'worker',
      'depot',
      'install',
      'api',
    ]);
    expect(LOG_LEVELS).toEqual(['debug', 'info', 'warn', 'error']);
  });
});
