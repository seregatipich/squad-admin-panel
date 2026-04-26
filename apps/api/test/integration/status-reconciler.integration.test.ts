import { servers } from '@squad/db/schema';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buildIntegrationApp,
  type IntegrationHarness,
  loginAsOwner,
  makeFakeBridge,
} from './harness.js';

const OWNER_STEAM_ID = 76561198000000777n;

const createBody = {
  display_name: 'Reconciler Server',
  slug: 'reconciler-server',
  description: 'reconciler integration fixture',
  game_port: 7787,
  query_port: 27165,
  beacon_port: 15000,
  rcon_port: 21114,
  max_players: 80,
  tickrate: 50,
  multihome: '0.0.0.0',
  extra_args: '',
};

let h: IntegrationHarness;

beforeEach(async () => {
  h = await buildIntegrationApp({
    seedOwner: { steamId64: OWNER_STEAM_ID },
    bridge: makeFakeBridge(),
    withStatusReconciler: true,
  });
});

afterEach(async () => {
  await h.cleanup();
});

async function createServer(): Promise<string> {
  const cookie = await loginAsOwner(h);
  const r = await h.app.inject({
    method: 'POST',
    url: '/api/v1/servers',
    headers: { cookie },
    payload: createBody,
  });
  return r.json<{ id: string }>().id;
}

describe('status-reconciler tick', () => {
  it("flips status='stopping' to 'stopped' once docker reports exited", async () => {
    const id = await createServer();
    await h.db
      .update(servers)
      .set({ status: 'stopping', updatedAt: new Date() })
      .where(eq(servers.id, id));
    h.bridge.containerInspect = async ({ name }) => ({
      name,
      state: 'exited',
      running: false,
      pid: 0,
      started_at: '2026-04-26T00:00:00Z',
      finished_at: '2026-04-26T00:01:00Z',
      exit_code: 0,
      image: 'squad-server:latest',
      restart_count: 0,
      labels: {},
    });

    await h.app.statusReconciler.tickNow();

    const [row] = await h.db.select().from(servers).where(eq(servers.id, id));
    expect(row?.status).toBe('stopped');
  });

  it("flips status='starting' to 'running' once docker reports running", async () => {
    const id = await createServer();
    await h.db
      .update(servers)
      .set({ status: 'starting', updatedAt: new Date() })
      .where(eq(servers.id, id));
    h.bridge.containerInspect = async ({ name }) => ({
      name,
      state: 'running',
      running: true,
      pid: 12345,
      started_at: '2026-04-26T00:00:00Z',
      finished_at: '',
      exit_code: 0,
      image: 'squad-server:latest',
      restart_count: 0,
      labels: {},
    });

    await h.app.statusReconciler.tickNow();

    const [row] = await h.db.select().from(servers).where(eq(servers.id, id));
    expect(row?.status).toBe('running');
    expect(row?.containerId).toBe('12345');
  });

  it('treats not_found as stopped — never leaves a row stuck on a missing container', async () => {
    const id = await createServer();
    await h.db
      .update(servers)
      .set({ status: 'stopping', updatedAt: new Date() })
      .where(eq(servers.id, id));
    h.bridge.containerInspect = async ({ name }) => ({
      name,
      state: 'not_found',
      running: false,
      pid: 0,
      started_at: '',
      finished_at: '',
      exit_code: 0,
      image: '',
      restart_count: 0,
      labels: {},
    });

    await h.app.statusReconciler.tickNow();

    const [row] = await h.db.select().from(servers).where(eq(servers.id, id));
    expect(row?.status).toBe('stopped');
  });

  it('keeps DB status untouched when docker returns an unknown state and surfaces a stuck server', async () => {
    const id = await createServer();
    const stuckSince = new Date(Date.now() - 10 * 60_000);
    await h.db
      .update(servers)
      .set({ status: 'stopping', updatedAt: stuckSince })
      .where(eq(servers.id, id));
    h.bridge.containerInspect = async ({ name }) => ({
      name,
      state: 'mystery-state',
      running: false,
      pid: 0,
      started_at: '',
      finished_at: '',
      exit_code: 0,
      image: '',
      restart_count: 0,
      labels: {},
    });

    await h.app.statusReconciler.tickNow();

    const [row] = await h.db.select().from(servers).where(eq(servers.id, id));
    expect(row?.status).toBe('stopping');
    const stats = await h.app.statusReconciler.stats();
    expect(stats.stuck_servers.find((s) => s.id === id)).toBeDefined();
  });

  it('counts consecutive bridge failures without crashing the loop', async () => {
    const id = await createServer();
    await h.db
      .update(servers)
      .set({ status: 'stopping', updatedAt: new Date() })
      .where(eq(servers.id, id));
    let failCount = 0;
    h.bridge.containerInspect = async () => {
      failCount++;
      throw new Error('bridge unavailable');
    };

    await h.app.statusReconciler.tickNow();
    await h.app.statusReconciler.tickNow();
    await h.app.statusReconciler.tickNow();

    expect(failCount).toBe(3);
    const stats = await h.app.statusReconciler.stats();
    expect(stats.bridge_failures_by_server[id]).toBe(3);
  });

  it('clears the bridge-failure counter when the next inspect succeeds', async () => {
    const id = await createServer();
    await h.db
      .update(servers)
      .set({ status: 'stopping', updatedAt: new Date() })
      .where(eq(servers.id, id));
    let calls = 0;
    h.bridge.containerInspect = async ({ name }) => {
      calls++;
      if (calls === 1) throw new Error('bridge briefly unreachable');
      return {
        name,
        state: 'exited',
        running: false,
        pid: 0,
        started_at: '',
        finished_at: '',
        exit_code: 0,
        image: '',
        restart_count: 0,
        labels: {},
      };
    };

    await h.app.statusReconciler.tickNow();
    await h.app.statusReconciler.tickNow();

    const [row] = await h.db.select().from(servers).where(eq(servers.id, id));
    expect(row?.status).toBe('stopped');
    const stats = await h.app.statusReconciler.stats();
    expect(stats.bridge_failures_by_server[id]).toBeUndefined();
  });
});

describe('POST /api/v1/servers/:id/reconcile', () => {
  it('forces an immediate reconcile and returns the resulting state', async () => {
    const cookie = await loginAsOwner(h);
    const id = await createServer();
    await h.db
      .update(servers)
      .set({ status: 'stopping', updatedAt: new Date() })
      .where(eq(servers.id, id));
    h.bridge.containerInspect = async ({ name }) => ({
      name,
      state: 'exited',
      running: false,
      pid: 0,
      started_at: '',
      finished_at: '',
      exit_code: 0,
      image: '',
      restart_count: 0,
      labels: {},
    });

    const resp = await h.app.inject({
      method: 'POST',
      url: `/api/v1/servers/${id}/reconcile`,
      headers: { cookie },
    });
    expect(resp.statusCode).toBe(200);
    const body = resp.json<{
      previous_status: string;
      new_status: string;
      changed: boolean;
      inspected_state: string;
    }>();
    expect(body.previous_status).toBe('stopping');
    expect(body.new_status).toBe('stopped');
    expect(body.changed).toBe(true);

    const [row] = await h.db.select().from(servers).where(eq(servers.id, id));
    expect(row?.status).toBe('stopped');
  });

  it('returns 502 when the bridge throws — but the next reconcile can still recover', async () => {
    const cookie = await loginAsOwner(h);
    const id = await createServer();
    await h.db
      .update(servers)
      .set({ status: 'stopping', updatedAt: new Date() })
      .where(eq(servers.id, id));
    let calls = 0;
    h.bridge.containerInspect = async ({ name }) => {
      calls++;
      if (calls === 1) throw new Error('bridge unavailable');
      return {
        name,
        state: 'exited',
        running: false,
        pid: 0,
        started_at: '',
        finished_at: '',
        exit_code: 0,
        image: '',
        restart_count: 0,
        labels: {},
      };
    };

    const fail = await h.app.inject({
      method: 'POST',
      url: `/api/v1/servers/${id}/reconcile`,
      headers: { cookie },
    });
    expect(fail.statusCode).toBe(502);

    const ok = await h.app.inject({
      method: 'POST',
      url: `/api/v1/servers/${id}/reconcile`,
      headers: { cookie },
    });
    expect(ok.statusCode).toBe(200);
    const [row] = await h.db.select().from(servers).where(eq(servers.id, id));
    expect(row?.status).toBe('stopped');
  });

  it('returns 404 for a deleted or unknown server', async () => {
    const cookie = await loginAsOwner(h);
    const resp = await h.app.inject({
      method: 'POST',
      url: '/api/v1/servers/019e0000-0000-7000-8000-000000000000/reconcile',
      headers: { cookie },
    });
    expect(resp.statusCode).toBe(404);
  });
});

describe('reconciler — fail-safe behavior', () => {
  it("does NOT touch 'installing' rows even when docker reports not_found", async () => {
    const id = await createServer();
    const installingSince = new Date(Date.now() - 60_000);
    await h.db
      .update(servers)
      .set({ status: 'installing', updatedAt: installingSince })
      .where(eq(servers.id, id));
    h.bridge.containerInspect = async ({ name }) => ({
      name,
      state: 'not_found',
      running: false,
      pid: 0,
      started_at: '',
      finished_at: '',
      exit_code: 0,
      image: '',
      restart_count: 0,
      labels: {},
    });

    await h.app.statusReconciler.tickNow();

    const [row] = await h.db.select().from(servers).where(eq(servers.id, id));
    expect(row?.status).toBe('installing');
  });

  it("flips an 'installing' row older than STALE_INSTALL_AFTER_MS to 'failed'", async () => {
    const id = await createServer();
    const ancient = new Date(Date.now() - 31 * 60_000);
    await h.db
      .update(servers)
      .set({ status: 'installing', updatedAt: ancient })
      .where(eq(servers.id, id));

    await h.app.statusReconciler.tickNow();

    const [row] = await h.db.select().from(servers).where(eq(servers.id, id));
    expect(row?.status).toBe('failed');
  });

  it('runs per-server inspects in parallel — slow servers do not delay fast ones', async () => {
    const fastId = await createServer();
    const slowCookie = await loginAsOwner(h);
    const slowResp = await h.app.inject({
      method: 'POST',
      url: '/api/v1/servers',
      headers: { cookie: slowCookie },
      payload: { ...createBody, slug: 'reconciler-slow', display_name: 'Slow' },
    });
    const slowId = slowResp.json<{ id: string }>().id;

    await h.db
      .update(servers)
      .set({ status: 'starting', updatedAt: new Date() })
      .where(eq(servers.id, fastId));
    await h.db
      .update(servers)
      .set({ status: 'starting', updatedAt: new Date() })
      .where(eq(servers.id, slowId));

    h.bridge.containerInspect = async ({ name }) => {
      const isSlow = name.endsWith(slowId);
      if (isSlow) {
        await new Promise((resolve) => setTimeout(resolve, 800));
      }
      return {
        name,
        state: 'running',
        running: true,
        pid: 1,
        started_at: '',
        finished_at: '',
        exit_code: 0,
        image: 'squad-server:latest',
        restart_count: 0,
        labels: {},
      };
    };

    const t0 = Date.now();
    await h.app.statusReconciler.tickNow();
    const elapsed = Date.now() - t0;

    expect(elapsed).toBeLessThan(1500);
    const [fast] = await h.db.select().from(servers).where(eq(servers.id, fastId));
    const [slow] = await h.db.select().from(servers).where(eq(servers.id, slowId));
    expect(fast?.status).toBe('running');
    expect(slow?.status).toBe('running');
  });

  it('runs an immediate recovery tick on plugin ready (api-restart scenario)', async () => {
    // The harness already registered the plugin with onReady-fired tick before
    // this test runs. Re-create the same scenario by inserting a stuck row,
    // then re-running the recovery via the public tickNow handle — this is
    // the exact code path onReady invokes on a fresh process.
    const id = await createServer();
    await h.db
      .update(servers)
      .set({ status: 'stopping', updatedAt: new Date() })
      .where(eq(servers.id, id));
    h.bridge.containerInspect = async ({ name }) => ({
      name,
      state: 'exited',
      running: false,
      pid: 0,
      started_at: '',
      finished_at: '',
      exit_code: 0,
      image: '',
      restart_count: 0,
      labels: {},
    });
    await h.app.statusReconciler.tickNow();
    const [row] = await h.db.select().from(servers).where(eq(servers.id, id));
    expect(row?.status).toBe('stopped');
  });
});

describe('GET /api/v1/health/reconciler', () => {
  it('returns stats including stuck servers and a healthy flag', async () => {
    const id = await createServer();
    const oldUpdate = new Date(Date.now() - 5 * 60_000);
    await h.db
      .update(servers)
      .set({ status: 'stopping', updatedAt: oldUpdate })
      .where(eq(servers.id, id));

    await h.app.statusReconciler.tickNow();

    const resp = await h.app.inject({ method: 'GET', url: '/api/v1/health/reconciler' });
    expect(resp.statusCode).toBe(200);
    const body = resp.json<{
      last_tick_at: string | null;
      stuck_servers: Array<{ id: string }>;
      healthy: boolean;
    }>();
    expect(body.last_tick_at).not.toBeNull();
    // After a successful tick the row was flipped to 'running' (default
    // FakeBridge inspect returns running=true), so it's no longer stuck.
    // Re-stick it and inspect again to verify the stuck path is observable.
    await h.db
      .update(servers)
      .set({ status: 'stopping', updatedAt: oldUpdate })
      .where(eq(servers.id, id));
    h.bridge.containerInspect = async ({ name }) => ({
      name,
      state: 'mystery',
      running: false,
      pid: 0,
      started_at: '',
      finished_at: '',
      exit_code: 0,
      image: '',
      restart_count: 0,
      labels: {},
    });
    await h.app.statusReconciler.tickNow();
    const stuckResp = await h.app.inject({ method: 'GET', url: '/api/v1/health/reconciler' });
    const stuckBody = stuckResp.json<{
      stuck_servers: Array<{ id: string; status: string; age_ms: number }>;
      healthy: boolean;
    }>();
    expect(stuckBody.stuck_servers.find((s) => s.id === id)).toBeDefined();
    expect(stuckBody.healthy).toBe(false);
  });
});
