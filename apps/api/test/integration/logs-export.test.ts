import { gunzipSync } from 'node:zlib';
import { servers as serversTable } from '@squad/db';
import {
  encodeLogEntry,
  HOST_METRICS_STREAM,
  PANEL_LOGS_STREAM,
  packHostMetrics,
} from '@squad/shared-config';
import { v7 as uuidv7 } from 'uuid';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildIntegrationApp, type IntegrationHarness, loginAsOwner } from './harness.js';

let h: IntegrationHarness;
let cookie: string;
let serverIdAlpha: string;

async function seedLog(e: {
  source: 'bridge' | 'rcon' | 'api' | 'log-ingest' | 'worker' | 'depot' | 'install';
  level: 'info' | 'warn' | 'debug' | 'error';
  msg: string;
  serverId?: string;
}): Promise<void> {
  const fields = encodeLogEntry(e);
  const args: unknown[] = [PANEL_LOGS_STREAM, '*'];
  for (const [k, v] of Object.entries(fields)) args.push(k, v);
  await h.redis.xadd(...(args as [string, ...string[]]));
}

beforeAll(async () => {
  h = await buildIntegrationApp({
    seedOwner: { steamId64: 76561198000000999n },
  });
  cookie = await loginAsOwner(h);

  serverIdAlpha = uuidv7();
  await h.db.insert(serversTable).values({
    id: serverIdAlpha,
    // `orgId` is neither an `IntegrationHarness['seed']` field nor a
    // `servers` column (drizzle's insert builder only reads keys that match
    // a real column, so this one is silently ignored either way); there is
    // no definedness invariant to assert, so cast instead of `!`.
    orgId: h.seed.orgId as string | undefined,
    displayName: 'Alpha',
    slug: 'alpha',
    gamePort: 7787,
    queryPort: 27165,
    rconPort: 21114,
    status: 'stopped',
  });
});

beforeEach(async () => {
  await h.redis.del(PANEL_LOGS_STREAM);
  await h.redis.del(HOST_METRICS_STREAM);
});

afterAll(async () => {
  await h?.cleanup();
});

describe('GET /api/v1/logs/export', () => {
  it('serves a gzipped sectioned text bundle with all expected headers in order', async () => {
    await seedLog({ source: 'bridge', level: 'info', msg: 'alive rtt=2ms' });
    await seedLog({ source: 'rcon', level: 'info', msg: 'auth ok', serverId: serverIdAlpha });
    await seedLog({
      source: 'log-ingest',
      level: 'info',
      msg: 'tail start',
      serverId: serverIdAlpha,
    });
    await seedLog({ source: 'worker', level: 'info', msg: 'heartbeat ok' });
    await seedLog({ source: 'depot', level: 'info', msg: 'update progress 50%' });
    await seedLog({ source: 'install', level: 'info', msg: 'seeded 19 cfg files' });
    await seedLog({ source: 'api', level: 'warn', msg: 'rate-limit hit' });

    const v = packHostMetrics({
      cpu_percent: 50,
      ram_used_bytes: 1,
      ram_total_bytes: 2,
      disk_used_bytes: 1,
      disk_total_bytes: 2,
      net_rx_bytes_per_sec: 0,
      net_tx_bytes_per_sec: 0,
      load_avg_1m: 0,
      load_avg_5m: 0,
      load_avg_15m: 0,
    });
    await h.redis.xadd(HOST_METRICS_STREAM, '*', 'v', JSON.stringify(v));

    h.bridge.containerLogsFollow = vi.fn(async (_p, onFrame) => {
      onFrame({ stream: 'stdout', data: 'squad-game line A\n' });
    }) as never;

    const res = await h.app.inject({
      method: 'GET',
      url: '/api/v1/logs/export',
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-encoding']).toBe('gzip');
    expect(String(res.headers['content-type'] ?? '')).toMatch(/text\/plain/);
    const text = gunzipSync(res.rawPayload).toString('utf-8');
    const sections = [
      '===== BRIDGE =====',
      '===== RCON server',
      '===== LOG-INGEST server',
      '===== WORKERS =====',
      '===== DEPOT / INSTALL =====',
      '===== API =====',
      '===== HOST METRICS 24h (CSV) =====',
      'ts_iso,cpu_pct,ram_used,disk_used,rx_bps,tx_bps,la1,la5,la15',
      '===== AUDIT (last 24h) =====',
      '===== SQUAD GAME LOGS server',
    ];
    let pos = 0;
    for (const s of sections) {
      const i = text.indexOf(s, pos);
      expect(i, `section "${s}" missing or out of order`).toBeGreaterThanOrEqual(0);
      pos = i;
    }
    expect(text).toContain('alive rtt=2ms');
    expect(text).toContain('auth ok');
    expect(text).toContain('rate-limit hit');
    expect(text).toContain('Alpha');
  });

  it('still returns 200 (with empty sections) when there are no logs and no metrics', async () => {
    h.bridge.containerLogsFollow = vi.fn(async () => undefined) as never;
    const res = await h.app.inject({
      method: 'GET',
      url: '/api/v1/logs/export',
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    const text = gunzipSync(res.rawPayload).toString('utf-8');
    expect(text).toContain('===== BRIDGE =====');
    expect(text).toContain('===== HOST METRICS 24h (CSV) =====');
  });
});
