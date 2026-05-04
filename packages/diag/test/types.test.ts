import { describe, expect, it } from 'vitest';
import {
  DIAG_STREAM_KEY,
  DIAG_STREAM_MAXLEN,
  type DiagEvent,
  type DiagSeverity,
} from '../src/types.js';

describe('diag types constants', () => {
  it('DIAG_STREAM_KEY is diag:queue', () => {
    expect(DIAG_STREAM_KEY).toBe('diag:queue');
  });

  it('DIAG_STREAM_MAXLEN is 100000', () => {
    expect(DIAG_STREAM_MAXLEN).toBe(100_000);
  });

  it('DiagEvent interface is satisfied by a minimal object', () => {
    const ev: DiagEvent = {
      component: 'test',
      kind: 'test.kind',
      severity: 'info',
      message: 'hello',
    };
    expect(ev.component).toBe('test');
    expect(ev.kind).toBe('test.kind');
    expect(ev.severity).toBe('info');
    expect(ev.message).toBe('hello');
  });

  it('DiagSeverity accepts all valid values', () => {
    const severities: DiagSeverity[] = ['info', 'warn', 'error', 'fatal'];
    expect(severities).toHaveLength(4);
    for (const s of severities) {
      expect(typeof s).toBe('string');
    }
  });

  it('DiagEvent accepts optional fields', () => {
    const ev: DiagEvent = {
      component: 'bridge',
      kind: 'bridge.start',
      severity: 'info',
      message: 'started',
      serverId: '019d0000-0000-7000-8000-000000000000',
      actorSteamId64: '76561198000000001',
      requestId: 'req-1',
      payload: { key: 'value' },
    };
    expect(ev.serverId).toBe('019d0000-0000-7000-8000-000000000000');
    expect(ev.actorSteamId64).toBe('76561198000000001');
    expect(ev.requestId).toBe('req-1');
    expect(ev.payload).toEqual({ key: 'value' });
  });
});
