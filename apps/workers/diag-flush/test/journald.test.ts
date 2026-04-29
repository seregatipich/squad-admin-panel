import { describe, expect, it, vi } from 'vitest';
import { handleJournaldLine, parseJournaldLine } from '../src/journald-bridge.js';

const SAMPLE_DIAG_INNER = JSON.stringify({
  DIAG_EVENT: '1',
  component: 'bridge',
  kind: 'bridge.client.connected',
  severity: 'info',
  message: 'panel peer connected',
  ts: '2026-04-29T10:00:00Z',
  uid: 1000,
  pid: 4242,
  user: 'squad',
});

function makeJournaldLine(message: string): string {
  return JSON.stringify({
    __REALTIME_TIMESTAMP: '1745920800000000',
    _SYSTEMD_UNIT: 'panel-host-bridge.service',
    PRIORITY: '6',
    MESSAGE: message,
  });
}

const log = {
  warn: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  debug: vi.fn(),
};

describe('parseJournaldLine', () => {
  it('extracts diag fields from a wrapped journald line', () => {
    const parsed = parseJournaldLine(makeJournaldLine(SAMPLE_DIAG_INNER));
    expect(parsed).not.toBeNull();
    if (!parsed) throw new Error('unreachable');
    expect(parsed.component).toBe('bridge');
    expect(parsed.kind).toBe('bridge.client.connected');
    expect(parsed.severity).toBe('info');
    expect(parsed.message).toBe('panel peer connected');
    expect(parsed.ts).toBe('2026-04-29T10:00:00Z');
    expect(parsed.payload).toEqual({ uid: 1000, pid: 4242, user: 'squad' });
  });

  it('returns null for blank lines', () => {
    expect(parseJournaldLine('')).toBeNull();
    expect(parseJournaldLine('   ')).toBeNull();
  });

  it('returns null for non-JSON outer lines', () => {
    expect(parseJournaldLine('not-json')).toBeNull();
  });

  it('returns null when MESSAGE is missing', () => {
    expect(
      parseJournaldLine(JSON.stringify({ _SYSTEMD_UNIT: 'panel-host-bridge.service' })),
    ).toBeNull();
  });

  it('returns null when MESSAGE is not our DIAG_EVENT JSON', () => {
    expect(parseJournaldLine(makeJournaldLine('plain log line'))).toBeNull();
    expect(
      parseJournaldLine(makeJournaldLine(JSON.stringify({ level: 'info', msg: 'noise' }))),
    ).toBeNull();
  });

  it('returns null when DIAG_EVENT is missing or not "1"', () => {
    expect(
      parseJournaldLine(
        makeJournaldLine(
          JSON.stringify({
            DIAG_EVENT: '0',
            component: 'x',
            kind: 'y',
            severity: 'info',
            message: 'm',
          }),
        ),
      ),
    ).toBeNull();
  });

  it('returns null when required fields are missing', () => {
    expect(
      parseJournaldLine(
        makeJournaldLine(
          JSON.stringify({ DIAG_EVENT: '1', component: 'bridge', severity: 'info', message: 'm' }),
        ),
      ),
    ).toBeNull();
  });

  it('falls back to current time when ts is missing', () => {
    const inner = JSON.stringify({
      DIAG_EVENT: '1',
      component: 'bridge',
      kind: 'bridge.test',
      severity: 'info',
      message: 'm',
    });
    const parsed = parseJournaldLine(makeJournaldLine(inner));
    expect(parsed).not.toBeNull();
    if (!parsed) throw new Error('unreachable');
    expect(parsed.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});

describe('handleJournaldLine', () => {
  it('XADDs the parsed entry into diag:queue with the contracted shape', async () => {
    const xadd = vi.fn().mockResolvedValue('1700-0');
    const redis = { xadd } as never;

    const ok = await handleJournaldLine(makeJournaldLine(SAMPLE_DIAG_INNER), { redis, log });
    expect(ok).toBe(true);
    expect(xadd).toHaveBeenCalledTimes(1);

    const args = xadd.mock.calls[0];
    if (!args) throw new Error('xadd not called');
    expect(args[0]).toBe('diag:queue');
    expect(args[1]).toBe('MAXLEN');
    expect(args[2]).toBe('~');
    expect(args[3]).toBe(100_000);
    expect(args[4]).toBe('*');

    const fields: Record<string, string> = {};
    for (let i = 5; i < args.length; i += 2) {
      fields[args[i] as string] = args[i + 1] as string;
    }
    expect(fields.component).toBe('bridge');
    expect(fields.kind).toBe('bridge.client.connected');
    expect(fields.severity).toBe('info');
    expect(fields.message).toBe('panel peer connected');
    expect(fields.ts).toBe('2026-04-29T10:00:00Z');
    expect(fields.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(JSON.parse(fields.payload)).toEqual({ uid: 1000, pid: 4242, user: 'squad' });
  });

  it('skips non-diag journald lines without calling XADD', async () => {
    const xadd = vi.fn();
    const redis = { xadd } as never;
    const ok = await handleJournaldLine(makeJournaldLine('plain log message'), { redis, log });
    expect(ok).toBe(false);
    expect(xadd).not.toHaveBeenCalled();
  });

  it('skips empty lines', async () => {
    const xadd = vi.fn();
    const redis = { xadd } as never;
    const ok = await handleJournaldLine('', { redis, log });
    expect(ok).toBe(false);
    expect(xadd).not.toHaveBeenCalled();
  });
});
