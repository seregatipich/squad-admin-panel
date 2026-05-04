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

  it('throws on unknown level code', () => {
    expect(() => decodeLogEntry('1-0', { s: 'A', l: 'Z', m: 'x' })).toThrow(/level/);
  });

  it('throws when sourceFromCode receives an unknown short code', () => {
    expect(() => sourceFromCode('Z')).toThrow(/source/);
  });

  it('treats malformed ctx JSON as { _raw } so a corrupt entry never throws', () => {
    const decoded = decodeLogEntry('1700000000000-0', {
      s: 'A',
      l: 'I',
      m: 'x',
      c: '{not json',
    });
    expect(decoded.ctx).toEqual({ _raw: '{not json' });
  });

  it('decodes a missing msg field as the empty string', () => {
    const decoded = decodeLogEntry('1700000000000-0', { s: 'A', l: 'I' });
    expect(decoded.msg).toBe('');
  });

  it('decodes missing source/level codes as undefined sentinels that throw', () => {
    expect(() => decodeLogEntry('1-0', {})).toThrow(/source/);
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
      'config-sync',
    ]);
    expect(LOG_LEVELS).toEqual(['debug', 'info', 'warn', 'error']);
  });
});
