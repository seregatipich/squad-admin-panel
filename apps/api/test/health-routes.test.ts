import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import healthPlugin from '../src/plugins/health.js';

function buildFakes() {
  return {
    db: {
      execute: vi.fn().mockResolvedValue([{ '?column?': 1 }]),
    },
    redis: {
      ping: vi.fn().mockResolvedValue('PONG'),
      scan: vi.fn().mockResolvedValue(['0', []]),
      get: vi.fn().mockResolvedValue(null),
    },
    bridge: {
      ping: vi.fn().mockResolvedValue({ pong: true, version: '1.0.0', hostname: 'test' }),
    },
    statusReconciler: {
      stats: vi.fn().mockResolvedValue({
        last_tick_at: new Date().toISOString(),
        last_tick_duration_ms: 50,
        last_tick_servers_inspected: 2,
        last_tick_budget_exceeded: false,
        consecutive_tick_errors: 0,
        servers_in_transient: 0,
        stuck_servers: [],
        stale_installs_failed: 0,
        bridge_failures_by_server: {},
      }),
    },
  };
}

let app: Awaited<ReturnType<typeof Fastify>>;
let fakes: ReturnType<typeof buildFakes>;

beforeEach(async () => {
  fakes = buildFakes();
  app = Fastify();
  app.decorate('db', fakes.db);
  app.decorate('redis', fakes.redis);
  app.decorate('bridge', fakes.bridge);
  app.decorate('statusReconciler', fakes.statusReconciler);
  await app.register(healthPlugin);
  await app.ready();
});

afterEach(async () => {
  await app.close();
});

describe('GET /health', () => {
  it('returns status ok with uptime and version', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe('ok');
    expect(typeof body.uptime_s).toBe('number');
    expect(body.version).toBeDefined();
  });
});

describe('GET /ready', () => {
  it('returns 200 when all subsystems healthy', async () => {
    const res = await app.inject({ method: 'GET', url: '/ready' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe('ok');
    expect(body.checks.postgres).toBe('ok');
    expect(body.checks.redis).toBe('ok');
    expect(body.checks.bridge).toBe('ok');
  });

  it('returns 503 when postgres fails', async () => {
    fakes.db.execute.mockRejectedValueOnce(new Error('connection refused'));
    const res = await app.inject({ method: 'GET', url: '/ready' });
    expect(res.statusCode).toBe(503);
    const body = res.json();
    expect(body.status).toBe('degraded');
    expect(body.checks.postgres).toBe('connection refused');
  });

  it('returns 503 when redis fails', async () => {
    fakes.redis.ping.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    const res = await app.inject({ method: 'GET', url: '/ready' });
    expect(res.statusCode).toBe(503);
    const body = res.json();
    expect(body.status).toBe('degraded');
    expect(body.checks.redis).toBe('ECONNREFUSED');
  });

  it('returns 503 when bridge fails', async () => {
    fakes.bridge.ping.mockRejectedValueOnce(new Error('socket: ENOENT'));
    const res = await app.inject({ method: 'GET', url: '/ready' });
    expect(res.statusCode).toBe(503);
    const body = res.json();
    expect(body.status).toBe('degraded');
    expect(body.checks.bridge).toBe('socket: ENOENT');
  });

  it('returns degraded when bridge pong is false', async () => {
    fakes.bridge.ping.mockResolvedValueOnce({ pong: false });
    const res = await app.inject({ method: 'GET', url: '/ready' });
    expect(res.statusCode).toBe(503);
    expect(res.json().checks.bridge).toBe('no pong');
  });

  it('returns degraded when redis ping is not PONG', async () => {
    fakes.redis.ping.mockResolvedValueOnce('LOADING');
    const res = await app.inject({ method: 'GET', url: '/ready' });
    expect(res.statusCode).toBe(503);
    expect(res.json().checks.redis).toBe('LOADING');
  });
});

describe('GET /api/v1/health/workers', () => {
  it('returns empty items when no heartbeat keys exist', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/health/workers' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.items).toEqual([]);
    expect(body.total).toBe(0);
  });

  it('returns parsed heartbeat payloads sorted by name', async () => {
    const now = Date.now();
    const rconPayload = JSON.stringify({
      name: 'rcon',
      ts: new Date(now - 1000).toISOString(),
      status: 'ok',
    });
    const ingestPayload = JSON.stringify({
      name: 'log-ingest',
      ts: new Date(now - 500).toISOString(),
      status: 'ok',
    });

    fakes.redis.scan.mockResolvedValueOnce([
      '0',
      ['worker:heartbeat:rcon', 'worker:heartbeat:log-ingest'],
    ]);
    fakes.redis.get.mockResolvedValueOnce(rconPayload).mockResolvedValueOnce(ingestPayload);

    const res = await app.inject({ method: 'GET', url: '/api/v1/health/workers' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.total).toBe(2);
    expect(body.items[0].name).toBe('log-ingest');
    expect(body.items[1].name).toBe('rcon');
    expect(typeof body.items[0].age_ms).toBe('number');
  });

  it('filters out keys with null values', async () => {
    fakes.redis.scan.mockResolvedValueOnce(['0', ['worker:heartbeat:ghost']]);
    fakes.redis.get.mockResolvedValueOnce(null);
    const res = await app.inject({ method: 'GET', url: '/api/v1/health/workers' });
    expect(res.json().total).toBe(0);
  });

  it('filters out malformed JSON payloads', async () => {
    fakes.redis.scan.mockResolvedValueOnce(['0', ['worker:heartbeat:bad']]);
    fakes.redis.get.mockResolvedValueOnce('not-json');
    const res = await app.inject({ method: 'GET', url: '/api/v1/health/workers' });
    expect(res.json().total).toBe(0);
  });

  it('handles multi-page scan results', async () => {
    const payload = JSON.stringify({ name: 'rcon', ts: new Date().toISOString(), status: 'ok' });
    fakes.redis.scan
      .mockResolvedValueOnce(['42', ['worker:heartbeat:rcon']])
      .mockResolvedValueOnce(['0', []]);
    fakes.redis.get.mockResolvedValueOnce(payload);
    const res = await app.inject({ method: 'GET', url: '/api/v1/health/workers' });
    expect(res.json().total).toBe(1);
  });
});

describe('GET /api/v1/health/reconciler', () => {
  it('returns stats with healthy=true when reconciler is alive', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/health/reconciler' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.healthy).toBe(true);
    expect(body.last_tick_at).toBeDefined();
  });

  it('returns healthy=false when last_tick_at is null', async () => {
    fakes.statusReconciler.stats.mockResolvedValueOnce({
      last_tick_at: null,
      last_tick_duration_ms: null,
      last_tick_servers_inspected: 0,
      last_tick_budget_exceeded: false,
      consecutive_tick_errors: 0,
      servers_in_transient: 0,
      stuck_servers: [],
      stale_installs_failed: 0,
      bridge_failures_by_server: {},
    });
    const res = await app.inject({ method: 'GET', url: '/api/v1/health/reconciler' });
    expect(res.json().healthy).toBe(false);
  });

  it('returns healthy=false when consecutive_tick_errors > 0', async () => {
    fakes.statusReconciler.stats.mockResolvedValueOnce({
      last_tick_at: new Date().toISOString(),
      last_tick_duration_ms: 10,
      last_tick_servers_inspected: 1,
      last_tick_budget_exceeded: false,
      consecutive_tick_errors: 3,
      servers_in_transient: 0,
      stuck_servers: [],
      stale_installs_failed: 0,
      bridge_failures_by_server: {},
    });
    const res = await app.inject({ method: 'GET', url: '/api/v1/health/reconciler' });
    expect(res.json().healthy).toBe(false);
  });

  it('returns healthy=false when stuck_servers exist', async () => {
    fakes.statusReconciler.stats.mockResolvedValueOnce({
      last_tick_at: new Date().toISOString(),
      last_tick_duration_ms: 10,
      last_tick_servers_inspected: 1,
      last_tick_budget_exceeded: false,
      consecutive_tick_errors: 0,
      servers_in_transient: 1,
      stuck_servers: [
        { id: 'abc', status: 'starting', updated_at: new Date().toISOString(), age_ms: 60000 },
      ],
      stale_installs_failed: 0,
      bridge_failures_by_server: {},
    });
    const res = await app.inject({ method: 'GET', url: '/api/v1/health/reconciler' });
    expect(res.json().healthy).toBe(false);
  });

  it('returns healthy=false when last tick is stale (>12s ago)', async () => {
    fakes.statusReconciler.stats.mockResolvedValueOnce({
      last_tick_at: new Date(Date.now() - 15_000).toISOString(),
      last_tick_duration_ms: 10,
      last_tick_servers_inspected: 1,
      last_tick_budget_exceeded: false,
      consecutive_tick_errors: 0,
      servers_in_transient: 0,
      stuck_servers: [],
      stale_installs_failed: 0,
      bridge_failures_by_server: {},
    });
    const res = await app.inject({ method: 'GET', url: '/api/v1/health/reconciler' });
    expect(res.json().healthy).toBe(false);
  });
});
