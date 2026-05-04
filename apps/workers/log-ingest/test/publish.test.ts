import type { EventEnvelope } from '@squad/shared-types';
import { describe, expect, it, vi } from 'vitest';
import { publish } from '../src/publish.js';

const SERVER_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const EVENT_ID = 'bbbbbbbb-cccc-dddd-eeee-ffffffffffff';

function makeEnvelope(overrides?: Partial<EventEnvelope>): EventEnvelope {
  return {
    event_id: EVENT_ID,
    version: 1,
    type: 'player.connected',
    server_id: SERVER_ID,
    ts: new Date().toISOString(),
    actor: { kind: 'system', id: null },
    correlation_id: null,
    payload: { name: 'TestPlayer', steam_id64: '76561198000000001' },
    ...overrides,
  };
}

function makeRedis(setResult: 'OK' | null = 'OK') {
  return {
    set: vi.fn().mockResolvedValue(setResult),
    xadd: vi.fn().mockResolvedValue('0-1'),
  } as never;
}

describe('publish', () => {
  it('claims dedup key and XADDs to per-server stream on first call', async () => {
    const redis = makeRedis('OK');
    const envelope = makeEnvelope();
    await publish(redis, envelope);

    expect(
      (redis as ReturnType<typeof makeRedis> & { set: ReturnType<typeof vi.fn> }).set,
    ).toHaveBeenCalledOnce();
    const setArgs = (redis as ReturnType<typeof makeRedis> & { set: ReturnType<typeof vi.fn> }).set
      .mock.calls[0];
    expect(setArgs[0]).toContain(EVENT_ID);
    expect(setArgs[4]).toBe('NX');

    expect(
      (redis as ReturnType<typeof makeRedis> & { xadd: ReturnType<typeof vi.fn> }).xadd,
    ).toHaveBeenCalledOnce();
    const xaddArgs = (redis as ReturnType<typeof makeRedis> & { xadd: ReturnType<typeof vi.fn> })
      .xadd.mock.calls[0];
    expect(xaddArgs[0]).toBe(`events:server:${SERVER_ID}`);
  });

  it('skips XADD when dedup key is already set (duplicate)', async () => {
    const redis = makeRedis(null);
    await publish(redis, makeEnvelope());

    expect(
      (redis as ReturnType<typeof makeRedis> & { set: ReturnType<typeof vi.fn> }).set,
    ).toHaveBeenCalledOnce();
    expect(
      (redis as ReturnType<typeof makeRedis> & { xadd: ReturnType<typeof vi.fn> }).xadd,
    ).not.toHaveBeenCalled();
  });

  it('routes to events:global stream when server_id is null', async () => {
    const redis = makeRedis('OK');
    const envelope = makeEnvelope({ server_id: null });
    await publish(redis, envelope);

    const xaddArgs = (redis as ReturnType<typeof makeRedis> & { xadd: ReturnType<typeof vi.fn> })
      .xadd.mock.calls[0];
    expect(xaddArgs[0]).toBe('events:global');
  });

  it('uses MAXLEN ~ 10000 cap on XADD', async () => {
    const redis = makeRedis('OK');
    await publish(redis, makeEnvelope());

    const xaddArgs = (redis as ReturnType<typeof makeRedis> & { xadd: ReturnType<typeof vi.fn> })
      .xadd.mock.calls[0] as string[];
    expect(xaddArgs).toContain('MAXLEN');
    expect(xaddArgs).toContain('~');
    expect(xaddArgs).toContain('10000');
  });

  it('serializes the envelope as JSON under the "envelope" field', async () => {
    const redis = makeRedis('OK');
    const envelope = makeEnvelope();
    await publish(redis, envelope);

    const xaddArgs = (redis as ReturnType<typeof makeRedis> & { xadd: ReturnType<typeof vi.fn> })
      .xadd.mock.calls[0] as string[];
    const envelopeIdx = xaddArgs.indexOf('envelope');
    expect(envelopeIdx).toBeGreaterThan(0);
    const serialized = xaddArgs[envelopeIdx + 1];
    expect(JSON.parse(serialized as string)).toMatchObject({ event_id: EVENT_ID });
  });

  it('sets dedup key with NX and EX options', async () => {
    const redis = makeRedis('OK');
    await publish(redis, makeEnvelope());

    const setArgs = (redis as ReturnType<typeof makeRedis> & { set: ReturnType<typeof vi.fn> }).set
      .mock.calls[0] as unknown[];
    expect(setArgs).toContain('EX');
    expect(setArgs).toContain('NX');
    const exIdx = setArgs.indexOf('EX');
    expect(typeof setArgs[exIdx + 1]).toBe('number');
    expect(setArgs[exIdx + 1] as number).toBeGreaterThan(0);
  });
});
