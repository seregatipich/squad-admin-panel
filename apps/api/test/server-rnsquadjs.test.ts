import type { BridgeClient } from '@squad/bridge-client';
import type { DatabaseClient } from '@squad/db';
import { RNSQUADJS_CUTOVER_SET } from '@squad/shared-config';
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import type Redis from 'ioredis';
import { beforeEach, describe, expect, it, type Mock, vi } from 'vitest';

// writeSidecarConfig performs real fs writes under /run; stub it so cutover
// tests never touch the host's runtime dir. buildSidecarEnv / sidecar naming
// stay real so the env + container name asserted below are the production shape.
vi.mock('../src/lib/rnsquadjs.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/rnsquadjs.js')>()),
  writeSidecarConfig: vi.fn().mockResolvedValue(undefined),
}));

import { writeSidecarConfig } from '../src/lib/rnsquadjs.js';
import serverRnsquadjsRoutes, {
  CUTOVER_TICK_MS,
  sidecarStatusKey,
} from '../src/routes/server-rnsquadjs.js';

const SERVER_ID = '0190a000-0000-7000-8000-000000000001';
const CUTOVER_URL = `/api/v1/servers/${SERVER_ID}/rnsquadjs`;

interface RedisStub {
  sadd: Mock;
  srem: Mock;
  sismember: Mock;
  /** Only the status route reads keys; the cutover route never calls it. */
  mget?: Mock;
}

interface BridgeStub {
  containerRm: Mock;
  containerRunRnsquadjs: Mock;
}

function makeSpyLogger(): { logger: FastifyBaseLogger; error: Mock } {
  const error = vi.fn();
  const logger = {
    level: 'info',
    fatal: vi.fn(),
    error,
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    silent: vi.fn(),
  } as unknown as FastifyBaseLogger;
  (logger as { child: () => FastifyBaseLogger }).child = () => logger;
  return { logger, error };
}

async function buildApp(opts: {
  findFirst: Mock;
  redis: RedisStub;
  bridge: BridgeStub;
}): Promise<{ app: FastifyInstance; errorLog: Mock }> {
  const { logger, error } = makeSpyLogger();
  const app = Fastify({ loggerInstance: logger });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.decorate('db', {
    query: { servers: { findFirst: opts.findFirst } },
  } as unknown as DatabaseClient);
  app.decorate('redis', opts.redis as unknown as Redis);
  app.decorate('bridge', opts.bridge as unknown as BridgeClient);
  await app.register(serverRnsquadjsRoutes);
  await app.ready();
  return { app, errorLog: error };
}

interface CapturedRoute {
  url: string;
  method: string;
  config?: Record<string, unknown>;
}

/**
 * Registers the module against a bare Fastify instance and returns every route
 * it declared. `method` is captured alongside `url` because this module now
 * registers two routes on the same URL.
 */
async function captureRoutes(): Promise<CapturedRoute[]> {
  const captured: CapturedRoute[] = [];
  const app = Fastify({ logger: false });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.addHook('onRoute', (route) => {
    for (const method of Array.isArray(route.method) ? route.method : [route.method]) {
      captured.push({ url: route.url, method, config: route.config as Record<string, unknown> });
    }
  });
  await app.register(serverRnsquadjsRoutes);
  await app.ready();
  await app.close();
  return captured;
}

function inject(app: FastifyInstance, mode: 'production' | 'shadow', url = CUTOVER_URL) {
  return app.inject({
    method: 'POST',
    url,
    headers: { 'content-type': 'application/json' },
    payload: { mode },
  });
}

beforeEach(() => {
  vi.mocked(writeSidecarConfig).mockClear();
});

describe('POST /api/v1/servers/:id/rnsquadjs', () => {
  describe('→ production (cutover)', () => {
    it('SADDs the cutover set, returns 202 immediately, then rm+run after one reconcile tick', async () => {
      const findFirst = vi.fn().mockResolvedValue({ id: SERVER_ID });
      const sadd = vi.fn().mockResolvedValue(1);
      const sismember = vi.fn().mockResolvedValue(1);
      const containerRm = vi.fn().mockResolvedValue({ status: 'ok' });
      const containerRunRnsquadjs = vi
        .fn()
        .mockResolvedValue({ container_id: 'rnsquadjs-prod', status: 'started' });
      const { app } = await buildApp({
        findFirst,
        redis: { sadd, srem: vi.fn(), sismember },
        bridge: { containerRm, containerRunRnsquadjs },
      });

      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      try {
        const res = await inject(app, 'production');
        expect(res.statusCode).toBe(202);
        expect(res.json()).toEqual({
          server_id: SERVER_ID,
          mode: 'production',
          status: 'switching',
        });
        expect(sadd).toHaveBeenCalledWith(RNSQUADJS_CUTOVER_SET, SERVER_ID);
        // The continuation is parked on the reconcile-tick timer: the legacy
        // tailer must stop before the sidecar starts, so nothing is touched yet.
        expect(writeSidecarConfig).not.toHaveBeenCalled();
        expect(containerRm).not.toHaveBeenCalled();
        expect(containerRunRnsquadjs).not.toHaveBeenCalled();

        await vi.advanceTimersByTimeAsync(CUTOVER_TICK_MS);

        // Re-checks desired state after the wait (still a cutover member).
        expect(sismember).toHaveBeenCalledWith(RNSQUADJS_CUTOVER_SET, SERVER_ID);
        expect(writeSidecarConfig).toHaveBeenCalledTimes(1);
        expect(containerRm).toHaveBeenCalledWith({ name: `rnsquadjs-${SERVER_ID}` });
        // The tick above already drove the reconcile pass through to
        // containerRunRnsquadjs, so mock.calls[0] is defined.
        const call = containerRunRnsquadjs.mock.calls[0] as unknown[];
        const runArg = call[0] as {
          server_id: string;
          env: Record<string, string>;
        };
        expect(runArg.server_id).toBe(SERVER_ID);
        expect(runArg.env.PANEL_BRIDGE_MODE).toBe('production');

        // Ordering invariant: sadd < rm < run. sadd, containerRm, and
        // containerRunRnsquadjs were all confirmed called above (the SADD
        // assertion, the containerRm toHaveBeenCalledWith, and the runArg
        // extraction), so invocationCallOrder[0] is defined for each.
        const saddOrder = sadd.mock.invocationCallOrder[0] as number;
        const rmOrder = containerRm.mock.invocationCallOrder[0] as number;
        const runOrder = containerRunRnsquadjs.mock.invocationCallOrder[0] as number;
        expect(saddOrder).toBeLessThan(rmOrder);
        expect(rmOrder).toBeLessThan(runOrder);
      } finally {
        vi.useRealTimers();
      }
      await app.close();
    });

    it('ignores a containerRm failure (old sidecar may not exist) and still runs', async () => {
      const findFirst = vi.fn().mockResolvedValue({ id: SERVER_ID });
      const containerRm = vi.fn().mockRejectedValue(new Error('No such container'));
      const containerRunRnsquadjs = vi
        .fn()
        .mockResolvedValue({ container_id: 'rnsquadjs-prod', status: 'started' });
      const { app } = await buildApp({
        findFirst,
        redis: {
          sadd: vi.fn().mockResolvedValue(1),
          srem: vi.fn(),
          sismember: vi.fn().mockResolvedValue(1),
        },
        bridge: { containerRm, containerRunRnsquadjs },
      });

      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      try {
        const res = await inject(app, 'production');
        expect(res.statusCode).toBe(202);
        await vi.advanceTimersByTimeAsync(CUTOVER_TICK_MS);
        expect(containerRunRnsquadjs).toHaveBeenCalledTimes(1);
      } finally {
        vi.useRealTimers();
      }
      await app.close();
    });

    it('aborts the stale continuation if a rollback SREMs the set during the wait', async () => {
      // production cutover starts, then a shadow rollback removes the server
      // from the set before the reconcile tick elapses: the continuation must
      // NOT swap the sidecar, or it would resurrect a duplicate publisher.
      const findFirst = vi.fn().mockResolvedValue({ id: SERVER_ID });
      const sadd = vi.fn().mockResolvedValue(1);
      const srem = vi.fn().mockResolvedValue(1);
      const sismember = vi.fn().mockResolvedValue(0);
      const containerRm = vi.fn().mockResolvedValue({ status: 'ok' });
      const containerRunRnsquadjs = vi
        .fn()
        .mockResolvedValue({ container_id: 'rnsquadjs-prod', status: 'started' });
      const { app } = await buildApp({
        findFirst,
        redis: { sadd, srem, sismember },
        bridge: { containerRm, containerRunRnsquadjs },
      });

      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      try {
        const res = await inject(app, 'production');
        expect(res.statusCode).toBe(202);
        expect(sadd).toHaveBeenCalledWith(RNSQUADJS_CUTOVER_SET, SERVER_ID);
        await vi.advanceTimersByTimeAsync(CUTOVER_TICK_MS);

        expect(sismember).toHaveBeenCalledWith(RNSQUADJS_CUTOVER_SET, SERVER_ID);
        expect(writeSidecarConfig).not.toHaveBeenCalled();
        expect(containerRm).not.toHaveBeenCalled();
        expect(containerRunRnsquadjs).not.toHaveBeenCalled();
        // A supersession abort is the rollback's own doing (it already SREMd):
        // the aborted continuation must NOT srem again, or it would race a
        // freshly re-SADDed cutover.
        expect(srem).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
      await app.close();
    });

    it('does not launch production if the set is SREMd during the config/rm phase', async () => {
      // Member at the post-wait check (1), then a rollback SREMs it before the
      // pre-launch re-check (0): config + rm already ran, but the production
      // sidecar must NOT start — that would duplicate the resumed legacy tailer.
      const findFirst = vi.fn().mockResolvedValue({ id: SERVER_ID });
      const srem = vi.fn().mockResolvedValue(1);
      const sismember = vi.fn().mockResolvedValueOnce(1).mockResolvedValue(0);
      const containerRm = vi.fn().mockResolvedValue({ status: 'ok' });
      const containerRunRnsquadjs = vi
        .fn()
        .mockResolvedValue({ container_id: 'rnsquadjs-prod', status: 'started' });
      const { app } = await buildApp({
        findFirst,
        redis: { sadd: vi.fn().mockResolvedValue(1), srem, sismember },
        bridge: { containerRm, containerRunRnsquadjs },
      });

      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      try {
        const res = await inject(app, 'production');
        expect(res.statusCode).toBe(202);
        await vi.advanceTimersByTimeAsync(CUTOVER_TICK_MS);

        expect(sismember).toHaveBeenCalledTimes(2);
        expect(writeSidecarConfig).toHaveBeenCalledTimes(1);
        expect(containerRm.mock.calls.map((call) => call[0].name)).toEqual([
          `rnsquadjs-${SERVER_ID}`,
        ]);
        expect(containerRunRnsquadjs).not.toHaveBeenCalled();
        // Pre-launch supersession abort — not a failure, so no auto-rollback.
        expect(srem).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
      await app.close();
    });

    it('auto-rolls back (SREM) and logs when the continuation fails, after the 202 is sent', async () => {
      // The 202 is already returned; a genuine failure in the detached
      // continuation must SREM the cutover set so log-ingest re-adopts the
      // server's legacy tailer instead of stranding it with no publisher.
      const findFirst = vi.fn().mockResolvedValue({ id: SERVER_ID });
      const srem = vi.fn().mockResolvedValue(1);
      const containerRunRnsquadjs = vi.fn().mockRejectedValue(new Error('rnsquadjs image missing'));
      const { app, errorLog } = await buildApp({
        findFirst,
        redis: {
          sadd: vi.fn().mockResolvedValue(1),
          srem,
          sismember: vi.fn().mockResolvedValue(1),
        },
        bridge: { containerRm: vi.fn().mockResolvedValue({ status: 'ok' }), containerRunRnsquadjs },
      });

      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      try {
        const res = await inject(app, 'production');
        expect(res.statusCode).toBe(202);
        await vi.advanceTimersByTimeAsync(CUTOVER_TICK_MS);
        expect(containerRunRnsquadjs).toHaveBeenCalledTimes(1);
        expect(srem).toHaveBeenCalledWith(RNSQUADJS_CUTOVER_SET, SERVER_ID);
        expect(errorLog).toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
      await app.close();
    });
  });

  describe('→ shadow (rollback)', () => {
    it('writes config, runs the shadow sidecar BEFORE SREM, returns 200 + container_id', async () => {
      const findFirst = vi.fn().mockResolvedValue({ id: SERVER_ID });
      const srem = vi.fn().mockResolvedValue(1);
      const containerRm = vi.fn().mockResolvedValue({ status: 'ok' });
      const containerRunRnsquadjs = vi
        .fn()
        .mockResolvedValue({ container_id: 'rnsquadjs-shadow', status: 'started' });
      const { app } = await buildApp({
        findFirst,
        redis: { sadd: vi.fn(), srem, sismember: vi.fn() },
        bridge: { containerRm, containerRunRnsquadjs },
      });

      const res = await inject(app, 'shadow');
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        server_id: SERVER_ID,
        mode: 'shadow',
        container_id: 'rnsquadjs-shadow',
      });

      expect(writeSidecarConfig).toHaveBeenCalledTimes(1);
      expect(containerRm).toHaveBeenCalledWith({ name: `rnsquadjs-${SERVER_ID}` });
      // inject() has already resolved, so the shadow-mode handler ran to
      // completion and containerRunRnsquadjs was called: mock.calls[0] is defined.
      const call = containerRunRnsquadjs.mock.calls[0] as unknown[];
      const runArg = call[0] as {
        server_id: string;
        env: Record<string, string>;
      };
      expect(runArg.env.PANEL_BRIDGE_MODE).toBe('shadow');

      // Rollback ordering invariant: run the shadow sidecar BEFORE re-enabling
      // the legacy tailer (SREM). Reversing it would let both publish — dups.
      // Both mocks were called during the already-resolved handler run above
      // (containerRunRnsquadjs via the runArg extraction, srem per the
      // asserted toHaveBeenCalledWith below), so invocationCallOrder[0] is
      // defined for each.
      const runOrder = containerRunRnsquadjs.mock.invocationCallOrder[0] as number;
      const sremOrder = srem.mock.invocationCallOrder[0] as number;
      expect(runOrder).toBeLessThan(sremOrder);
      expect(srem).toHaveBeenCalledWith(RNSQUADJS_CUTOVER_SET, SERVER_ID);

      await app.close();
    });

    it('ignores a containerRm failure (old sidecar may not exist) and still runs + SREMs', async () => {
      const findFirst = vi.fn().mockResolvedValue({ id: SERVER_ID });
      const srem = vi.fn().mockResolvedValue(1);
      const containerRm = vi.fn().mockRejectedValue(new Error('No such container'));
      const containerRunRnsquadjs = vi
        .fn()
        .mockResolvedValue({ container_id: 'rnsquadjs-shadow', status: 'started' });
      const { app } = await buildApp({
        findFirst,
        redis: { sadd: vi.fn(), srem, sismember: vi.fn() },
        bridge: { containerRm, containerRunRnsquadjs },
      });

      const res = await inject(app, 'shadow');
      expect(res.statusCode).toBe(200);
      expect(containerRunRnsquadjs).toHaveBeenCalledTimes(1);
      expect(srem).toHaveBeenCalledWith(RNSQUADJS_CUTOVER_SET, SERVER_ID);

      await app.close();
    });

    it('still SREMs and rejects with a 500 when the shadow relaunch throws', async () => {
      // A dead shadow sidecar with the legacy tailer resumed is the safe
      // degraded state: SREM must run even when the relaunch throws, and the
      // failure must surface to the caller as a 5xx (not a silent success).
      const findFirst = vi.fn().mockResolvedValue({ id: SERVER_ID });
      const srem = vi.fn().mockResolvedValue(1);
      const containerRm = vi.fn().mockResolvedValue({ status: 'ok' });
      const containerRunRnsquadjs = vi.fn().mockRejectedValue(new Error('rnsquadjs image missing'));
      const { app } = await buildApp({
        findFirst,
        redis: { sadd: vi.fn(), srem, sismember: vi.fn() },
        bridge: { containerRm, containerRunRnsquadjs },
      });

      const res = await inject(app, 'shadow');
      expect(res.statusCode).toBeGreaterThanOrEqual(500);
      expect(srem).toHaveBeenCalledWith(RNSQUADJS_CUTOVER_SET, SERVER_ID);

      await app.close();
    });
  });

  describe('invalid body', () => {
    it('rejects an unknown mode with 400 and touches neither redis nor the bridge', async () => {
      const findFirst = vi.fn().mockResolvedValue({ id: SERVER_ID });
      const sadd = vi.fn();
      const srem = vi.fn();
      const containerRunRnsquadjs = vi.fn();
      const { app } = await buildApp({
        findFirst,
        redis: { sadd, srem, sismember: vi.fn() },
        bridge: { containerRm: vi.fn(), containerRunRnsquadjs },
      });

      const res = await app.inject({
        method: 'POST',
        url: CUTOVER_URL,
        headers: { 'content-type': 'application/json' },
        payload: { mode: 'legacy' },
      });
      expect(res.statusCode).toBe(400);
      expect(sadd).not.toHaveBeenCalled();
      expect(srem).not.toHaveBeenCalled();
      expect(containerRunRnsquadjs).not.toHaveBeenCalled();

      await app.close();
    });
  });

  describe('unknown server', () => {
    it('returns 404 and touches neither redis nor the bridge', async () => {
      const findFirst = vi.fn().mockResolvedValue(undefined);
      const sadd = vi.fn();
      const srem = vi.fn();
      const containerRunRnsquadjs = vi.fn();
      const { app } = await buildApp({
        findFirst,
        redis: { sadd, srem, sismember: vi.fn() },
        bridge: { containerRm: vi.fn(), containerRunRnsquadjs },
      });

      const res = await inject(app, 'production');
      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual({ error: 'not_found' });
      expect(sadd).not.toHaveBeenCalled();
      expect(srem).not.toHaveBeenCalled();
      expect(containerRunRnsquadjs).not.toHaveBeenCalled();

      await app.close();
    });
  });

  describe('permission + audit parity with the stop route', () => {
    it('declares server:stop and the rnsquadjs cutover audit entry', async () => {
      const captured = await captureRoutes();

      // GET and POST share this URL, so the method is part of the match:
      // a URL-only `find` would return whichever registered first.
      const route = captured.find(
        (r) => r.url === '/api/v1/servers/:id/rnsquadjs' && r.method === 'POST',
      );
      expect(route).toBeDefined();
      expect(route?.config?.permissions).toEqual(['server:stop']);
      expect(route?.config?.audit).toEqual({
        action: 'server.rnsquadjs.cutover',
        resource: 'server',
      });
    });
  });
});

describe('GET /api/v1/servers/:id/rnsquadjs', () => {
  const STATUS_JSON = JSON.stringify({
    state: 'connected',
    lastChange: '2026-07-27T10:00:00.000Z',
  });

  function getStatus(app: FastifyInstance, url = CUTOVER_URL) {
    return app.inject({ method: 'GET', url });
  }

  it('reports production mode from the unsuffixed key for a cutover member', async () => {
    const findFirst = vi.fn().mockResolvedValue({ id: SERVER_ID });
    const sismember = vi.fn().mockResolvedValue(1);
    const mget = vi.fn().mockResolvedValue([STATUS_JSON, null]);
    const { app } = await buildApp({
      findFirst,
      redis: { sadd: vi.fn(), srem: vi.fn(), sismember, mget },
      bridge: { containerRm: vi.fn(), containerRunRnsquadjs: vi.fn() },
    });

    const res = await getStatus(app);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      server_id: SERVER_ID,
      mode: 'production',
      cutover: true,
      status: { state: 'connected', last_change: '2026-07-27T10:00:00.000Z' },
    });
    expect(sismember).toHaveBeenCalledWith(RNSQUADJS_CUTOVER_SET, SERVER_ID);
    // Both keys are fetched in one round trip; the shadow key is never skipped.
    expect(mget).toHaveBeenCalledWith(
      sidecarStatusKey(SERVER_ID, 'production'),
      sidecarStatusKey(SERVER_ID, 'shadow'),
    );

    await app.close();
  });

  it('reports shadow mode from the :shadow key for a non-member with a live sidecar', async () => {
    const shadowJson = JSON.stringify({
      state: 'disconnected',
      lastChange: '2026-07-27T11:30:00.000Z',
    });
    const { app } = await buildApp({
      findFirst: vi.fn().mockResolvedValue({ id: SERVER_ID }),
      redis: {
        sadd: vi.fn(),
        srem: vi.fn(),
        sismember: vi.fn().mockResolvedValue(0),
        mget: vi.fn().mockResolvedValue([null, shadowJson]),
      },
      bridge: { containerRm: vi.fn(), containerRunRnsquadjs: vi.fn() },
    });

    const res = await getStatus(app);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      server_id: SERVER_ID,
      mode: 'shadow',
      cutover: false,
      status: { state: 'disconnected', last_change: '2026-07-27T11:30:00.000Z' },
    });

    await app.close();
  });

  it('reports legacy mode with status=null when neither key is set', async () => {
    const { app } = await buildApp({
      findFirst: vi.fn().mockResolvedValue({ id: SERVER_ID }),
      redis: {
        sadd: vi.fn(),
        srem: vi.fn(),
        sismember: vi.fn().mockResolvedValue(0),
        mget: vi.fn().mockResolvedValue([null, null]),
      },
      bridge: { containerRm: vi.fn(), containerRunRnsquadjs: vi.fn() },
    });

    const res = await getStatus(app);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      server_id: SERVER_ID,
      mode: 'legacy',
      cutover: false,
      status: null,
    });

    await app.close();
  });

  it('keeps mode=production with status=null when the heartbeat has expired', async () => {
    const { app } = await buildApp({
      findFirst: vi.fn().mockResolvedValue({ id: SERVER_ID }),
      redis: {
        sadd: vi.fn(),
        srem: vi.fn(),
        sismember: vi.fn().mockResolvedValue(1),
        mget: vi.fn().mockResolvedValue([null, null]),
      },
      bridge: { containerRm: vi.fn(), containerRunRnsquadjs: vi.fn() },
    });

    const res = await getStatus(app);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      server_id: SERVER_ID,
      mode: 'production',
      cutover: true,
      status: null,
    });

    await app.close();
  });

  it('ignores a stale shadow heartbeat once the server is a cutover member', async () => {
    const { app } = await buildApp({
      findFirst: vi.fn().mockResolvedValue({ id: SERVER_ID }),
      redis: {
        sadd: vi.fn(),
        srem: vi.fn(),
        sismember: vi.fn().mockResolvedValue(1),
        mget: vi.fn().mockResolvedValue([null, STATUS_JSON]),
      },
      bridge: { containerRm: vi.fn(), containerRunRnsquadjs: vi.fn() },
    });

    expect((await getStatus(app)).json()).toEqual({
      server_id: SERVER_ID,
      mode: 'production',
      cutover: true,
      status: null,
    });

    await app.close();
  });

  it('degrades to status=null on an unparseable or malformed heartbeat', async () => {
    for (const raw of ['not json', JSON.stringify({ state: 'exploded' })]) {
      const { app } = await buildApp({
        findFirst: vi.fn().mockResolvedValue({ id: SERVER_ID }),
        redis: {
          sadd: vi.fn(),
          srem: vi.fn(),
          sismember: vi.fn().mockResolvedValue(1),
          mget: vi.fn().mockResolvedValue([raw, null]),
        },
        bridge: { containerRm: vi.fn(), containerRunRnsquadjs: vi.fn() },
      });
      const res = await getStatus(app);
      expect(res.statusCode).toBe(200);
      expect(res.json().status).toBeNull();
      await app.close();
    }
  });

  it('404s for an unknown server without reading redis', async () => {
    const sismember = vi.fn();
    const mget = vi.fn();
    const { app } = await buildApp({
      findFirst: vi.fn().mockResolvedValue(undefined),
      redis: { sadd: vi.fn(), srem: vi.fn(), sismember, mget },
      bridge: { containerRm: vi.fn(), containerRunRnsquadjs: vi.fn() },
    });

    const res = await getStatus(app);
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'not_found' });
    expect(sismember).not.toHaveBeenCalled();
    expect(mget).not.toHaveBeenCalled();

    await app.close();
  });

  it('rejects a non-uuid id with 400', async () => {
    const findFirst = vi.fn();
    const { app } = await buildApp({
      findFirst,
      redis: { sadd: vi.fn(), srem: vi.fn(), sismember: vi.fn(), mget: vi.fn() },
      bridge: { containerRm: vi.fn(), containerRunRnsquadjs: vi.fn() },
    });

    const res = await getStatus(app, '/api/v1/servers/not-a-uuid/rnsquadjs');
    expect(res.statusCode).toBe(400);
    expect(findFirst).not.toHaveBeenCalled();

    await app.close();
  });

  it('declares server:view and no audit entry', async () => {
    const captured = await captureRoutes();

    const route = captured.find(
      (r) => r.url === '/api/v1/servers/:id/rnsquadjs' && r.method === 'GET',
    );
    expect(route).toBeDefined();
    expect(route?.config?.permissions).toEqual(['server:view']);
    expect(route?.config?.audit).toBe(false);
  });
});

describe('sidecarStatusKey', () => {
  it('mirrors the sidecar RedisPublisher key layout for both modes', () => {
    expect(sidecarStatusKey(SERVER_ID, 'production')).toBe(`rnsquadjs:status:${SERVER_ID}`);
    expect(sidecarStatusKey(SERVER_ID, 'shadow')).toBe(`rnsquadjs:status:${SERVER_ID}:shadow`);
  });
});
