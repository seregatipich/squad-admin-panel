import { describe, expect, it, vi } from 'vitest';

vi.mock('@squad/db', () => ({
  createDatabaseClient: vi.fn(() => ({})),
  servers: {},
  auditLog: {},
  schema: {},
}));

vi.mock('@squad/db/schema', () => ({
  servers: { id: 'id', status: 'status' },
  auditLog: { id: 'id' },
  players: { steamId64: 'steamId64' },
  sessions: { id: 'id' },
  playerApiTokens: { id: 'id' },
  panelMeta: { key: 'key' },
}));

vi.mock('@squad/bridge-client', () => ({
  BridgeClient: class {
    on() {
      return this;
    }
  },
}));

vi.mock('@squad/shared-config', () => ({
  HEARTBEAT_PREFIX: 'worker:heartbeat:',
  HOST_METRICS_STREAM: 'host:metrics',
  PERMISSION_KEYS: [],
}));

vi.mock('@squad/diag', () => ({
  Diag: class {},
  createDiagClient: vi.fn(),
}));

vi.mock('ioredis', () => ({
  default: class {
    on() {
      return this;
    }
    subscribe() {}
    disconnect() {}
  },
}));

vi.mock('drizzle-orm', () => ({
  eq: vi.fn(),
  and: vi.fn(),
  sql: vi.fn(),
  isNull: vi.fn(),
  inArray: vi.fn(),
}));

vi.mock('drizzle-orm/postgres-js', () => ({
  drizzle: vi.fn(() => ({})),
}));

vi.mock('postgres', () => ({
  default: vi.fn(() => Object.assign(vi.fn(), { end: vi.fn() })),
}));

vi.mock('prom-client', () => ({
  Registry: class {},
  Counter: class {
    inc() {}
  },
  Histogram: class {
    observe() {}
  },
  collectDefaultMetrics: vi.fn(),
}));

vi.mock('fastify-plugin', () => ({
  default: (fn: unknown) => fn,
}));

vi.mock('../src/config.js', () => ({}));

vi.mock('../src/lib/audit.js', () => ({
  writeAuditEntry: vi.fn(),
}));

vi.mock('../src/lib/rbac.js', () => ({
  loadUserPermissions: vi.fn(),
}));

vi.mock('../src/lib/auto-prune.js', () => ({
  fireAutoPrune: vi.fn(),
}));

vi.mock('../src/lib/cleanup-orphans.js', () => ({
  cleanupOrphans: vi.fn(),
}));

vi.mock('../src/lib/logger.js', () => ({
  als: { run: vi.fn(), getStore: vi.fn() },
}));

import auditPlugin from '../src/plugins/audit.js';
import authPlugin from '../src/plugins/auth.js';
import bridgePlugin from '../src/plugins/bridge.js';
import bridgeHeartbeatPlugin from '../src/plugins/bridge-heartbeat.js';
import databasePlugin from '../src/plugins/database.js';
import dbHealthPlugin from '../src/plugins/db-health.js';
import { errorDiagPlugin } from '../src/plugins/error-diag.js';
import healthPlugin from '../src/plugins/health.js';
import heartbeatWatchPlugin from '../src/plugins/heartbeat-watch.js';
import installProgressPlugin from '../src/plugins/install-progress.js';
import liveBusPlugin from '../src/plugins/live-bus.js';
import metricsPlugin from '../src/plugins/metrics.js';
import orphanSweepPlugin from '../src/plugins/orphan-sweep.js';
import redisPlugin from '../src/plugins/redis.js';
import requestContextPlugin from '../src/plugins/request-context.js';
import statusReconcilerPlugin from '../src/plugins/status-reconciler.js';
import * as typesModule from '../src/plugins/types.js';

describe('plugins import graph', () => {
  it('audit exports a function', () => {
    expect(typeof auditPlugin).toBe('function');
  });

  it('auth exports a function', () => {
    expect(typeof authPlugin).toBe('function');
  });

  it('bridge-heartbeat exports a function', () => {
    expect(typeof bridgeHeartbeatPlugin).toBe('function');
  });

  it('bridge exports a function', () => {
    expect(typeof bridgePlugin).toBe('function');
  });

  it('database exports a function', () => {
    expect(typeof databasePlugin).toBe('function');
  });

  it('db-health exports a function', () => {
    expect(typeof dbHealthPlugin).toBe('function');
  });

  it('error-diag exports a plugin', () => {
    expect(typeof errorDiagPlugin).toBe('function');
  });

  it('health exports a function', () => {
    expect(typeof healthPlugin).toBe('function');
  });

  it('heartbeat-watch exports a function', () => {
    expect(typeof heartbeatWatchPlugin).toBe('function');
  });

  it('install-progress exports a function', () => {
    expect(typeof installProgressPlugin).toBe('function');
  });

  it('live-bus exports a function', () => {
    expect(typeof liveBusPlugin).toBe('function');
  });

  it('metrics exports a function', () => {
    expect(typeof metricsPlugin).toBe('function');
  });

  it('orphan-sweep exports a function', () => {
    expect(typeof orphanSweepPlugin).toBe('function');
  });

  it('redis exports a function', () => {
    expect(typeof redisPlugin).toBe('function');
  });

  it('request-context exports a function', () => {
    expect(typeof requestContextPlugin).toBe('function');
  });

  it('status-reconciler exports a function', () => {
    expect(typeof statusReconcilerPlugin).toBe('function');
  });

  it('types module is importable', () => {
    expect(typesModule).toBeDefined();
  });
});
