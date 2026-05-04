import { describe, expect, it, vi } from 'vitest';

vi.mock('ioredis', () => ({
  default: vi.fn(() => ({
    on: vi.fn(),
    quit: vi.fn().mockResolvedValue('OK'),
    xgroup: vi.fn().mockResolvedValue('OK'),
    xreadgroup: vi.fn().mockResolvedValue(null),
    xack: vi.fn().mockResolvedValue(1),
  })),
}));
vi.mock('@squad/shared-config', () => ({
  startHeartbeat: vi.fn(() => vi.fn()),
  DIAG_STREAM_KEY: 'diag:queue',
  DIAG_STREAM_MAXLEN: 100000,
}));
vi.mock('@squad/diag', () => ({
  createDiag: vi.fn(() => ({ emit: vi.fn().mockResolvedValue(undefined) })),
}));
vi.mock('postgres', () => ({
  default: vi.fn(() => ({
    unsafe: vi.fn().mockResolvedValue([]),
    end: vi.fn().mockResolvedValue(undefined),
  })),
}));
vi.mock('pino', () => {
  const logger = { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn(), fatal: vi.fn() };
  return { default: vi.fn(() => logger) };
});

import { emitStarted, emitStopped, flushBatch, parseEntry } from '../src/index.js';

describe('diag-flush index', () => {
  it('exports parseEntry', () => {
    expect(parseEntry).toBeDefined();
    expect(typeof parseEntry).toBe('function');
  });

  it('parseEntry returns null for insufficient fields', () => {
    expect(parseEntry(['id', 'x'])).toBeNull();
  });

  it('parseEntry parses valid entry', () => {
    const fields = [
      'id',
      'abc',
      'ts',
      '2026-01-01T00:00:00Z',
      'component',
      'bridge',
      'severity',
      'info',
      'kind',
      'test.kind',
      'message',
      'hello',
      'payload',
      '{"x":1}',
    ];
    const result = parseEntry(fields);
    expect(result).not.toBeNull();
    expect(result?.id).toBe('abc');
    expect(result?.component).toBe('bridge');
    expect(result?.payload).toBe('{"x":1}');
  });

  it('exports flushBatch', () => {
    expect(flushBatch).toBeDefined();
    expect(typeof flushBatch).toBe('function');
  });

  it('exports emitStarted and emitStopped', () => {
    expect(typeof emitStarted).toBe('function');
    expect(typeof emitStopped).toBe('function');
  });
});
