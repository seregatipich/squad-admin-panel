import { mkdtempSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Heartbeat, readBuildIdentityVersion } from '../src/panel-bridge/heartbeat.js';

const SERVER_ID = '019dbaa5-1234-7abc-8def-0123456789ab';

function makeRedis() {
  return { set: vi.fn().mockResolvedValue('OK') };
}

function writeIdentity(contents) {
  const dir = mkdtempSync(join(tmpdir(), 'panel-bridge-identity-'));
  const path = join(dir, 'build-identity.json');
  writeFileSync(path, contents);
  return path;
}

describe('readBuildIdentityVersion', () => {
  it('returns the build commit sha', () => {
    const path = writeIdentity(
      JSON.stringify({ commitSha: '258440d0fbc14a4a63e679c82f0f12e6bb987c81', workflowRunId: '1' }),
    );
    expect(readBuildIdentityVersion(path)).toBe('258440d0fbc14a4a63e679c82f0f12e6bb987c81');
  });

  it('falls back to unknown when the file is missing', () => {
    expect(readBuildIdentityVersion('/nonexistent/build-identity.json')).toBe('unknown');
  });

  it('falls back to unknown when the file is not valid JSON', () => {
    expect(readBuildIdentityVersion(writeIdentity('not json'))).toBe('unknown');
  });

  it('falls back to unknown when commitSha is absent', () => {
    expect(readBuildIdentityVersion(writeIdentity(JSON.stringify({ workflowRunId: '1' })))).toBe(
      'unknown',
    );
  });
});

describe('Heartbeat', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-08T03:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('writes the sidecar heartbeat key with a 30s TTL on start', async () => {
    const redis = makeRedis();
    const heartbeat = new Heartbeat(redis, SERVER_ID, { version: 'abc123' });

    heartbeat.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(redis.set).toHaveBeenCalledTimes(1);
    const [key, payload, ex, ttl] = redis.set.mock.calls[0];
    expect(key).toBe(`worker:heartbeat:sidecar:${SERVER_ID}`);
    expect(ex).toBe('EX');
    expect(ttl).toBe(30);
    expect(JSON.parse(payload)).toEqual({
      name: `squadjs2:${SERVER_ID}`,
      ts: '2026-09-08T03:00:00.000Z',
      pid: process.pid,
      hostname: hostname(),
      version: 'abc123',
      started_at: '2026-09-08T03:00:00.000Z',
      status: 'ok',
    });
    heartbeat.stop();
  });

  it('ticks every 10 seconds', async () => {
    const redis = makeRedis();
    const heartbeat = new Heartbeat(redis, SERVER_ID, { version: 'abc123' });

    heartbeat.start();
    await vi.advanceTimersByTimeAsync(25_000);

    expect(redis.set).toHaveBeenCalledTimes(3);
    heartbeat.stop();
  });

  it('stops ticking after stop()', async () => {
    const redis = makeRedis();
    const heartbeat = new Heartbeat(redis, SERVER_ID, { version: 'abc123' });

    heartbeat.start();
    await vi.advanceTimersByTimeAsync(0);
    heartbeat.stop();
    await vi.advanceTimersByTimeAsync(60_000);

    expect(redis.set).toHaveBeenCalledTimes(1);
  });

  it('keeps ticking after a failed write', async () => {
    const redis = makeRedis();
    redis.set.mockRejectedValueOnce(new Error('redis down'));
    const errors = [];
    const heartbeat = new Heartbeat(redis, SERVER_ID, {
      version: 'abc123',
      onError: (err) => errors.push(err),
    });

    heartbeat.start();
    await vi.advanceTimersByTimeAsync(10_000);

    expect(errors).toHaveLength(1);
    expect(redis.set).toHaveBeenCalledTimes(2);
    heartbeat.stop();
  });
});
