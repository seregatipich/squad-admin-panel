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
import serverRnsquadjsRoutes, { CUTOVER_TICK_MS } from '../src/routes/server-rnsquadjs.js';

const SERVER_ID = '0190a000-0000-7000-8000-000000000001';
const CUTOVER_URL = `/api/v1/servers/${SERVER_ID}/rnsquadjs`;

interface RedisStub {
  sadd: Mock;
  srem: Mock;
  sismember: Mock;
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
        const runArg = containerRunRnsquadjs.mock.calls[0]![0] as {
          server_id: string;
          env: Record<string, string>;
        };
        expect(runArg.server_id).toBe(SERVER_ID);
        expect(runArg.env.PANEL_BRIDGE_MODE).toBe('production');

        // Ordering invariant: sadd < rm < run.
        const saddOrder = sadd.mock.invocationCallOrder[0]!;
        const rmOrder = containerRm.mock.invocationCallOrder[0]!;
        const runOrder = containerRunRnsquadjs.mock.invocationCallOrder[0]!;
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
      const sismember = vi.fn().mockResolvedValue(0);
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
        expect(sadd).toHaveBeenCalledWith(RNSQUADJS_CUTOVER_SET, SERVER_ID);
        await vi.advanceTimersByTimeAsync(CUTOVER_TICK_MS);

        expect(sismember).toHaveBeenCalledWith(RNSQUADJS_CUTOVER_SET, SERVER_ID);
        expect(writeSidecarConfig).not.toHaveBeenCalled();
        expect(containerRm).not.toHaveBeenCalled();
        expect(containerRunRnsquadjs).not.toHaveBeenCalled();
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
      const sismember = vi.fn().mockResolvedValueOnce(1).mockResolvedValue(0);
      const containerRm = vi.fn().mockResolvedValue({ status: 'ok' });
      const containerRunRnsquadjs = vi
        .fn()
        .mockResolvedValue({ container_id: 'rnsquadjs-prod', status: 'started' });
      const { app } = await buildApp({
        findFirst,
        redis: { sadd: vi.fn().mockResolvedValue(1), srem: vi.fn(), sismember },
        bridge: { containerRm, containerRunRnsquadjs },
      });

      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      try {
        const res = await inject(app, 'production');
        expect(res.statusCode).toBe(202);
        await vi.advanceTimersByTimeAsync(CUTOVER_TICK_MS);

        expect(sismember).toHaveBeenCalledTimes(2);
        expect(writeSidecarConfig).toHaveBeenCalledTimes(1);
        expect(containerRm).toHaveBeenCalledTimes(1);
        expect(containerRunRnsquadjs).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
      await app.close();
    });

    it('a rejecting containerRunRnsquadjs does not fail the 202 — the continuation logs it', async () => {
      const findFirst = vi.fn().mockResolvedValue({ id: SERVER_ID });
      const containerRunRnsquadjs = vi.fn().mockRejectedValue(new Error('rnsquadjs image missing'));
      const { app, errorLog } = await buildApp({
        findFirst,
        redis: {
          sadd: vi.fn().mockResolvedValue(1),
          srem: vi.fn(),
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
      const runArg = containerRunRnsquadjs.mock.calls[0]![0] as {
        server_id: string;
        env: Record<string, string>;
      };
      expect(runArg.env.PANEL_BRIDGE_MODE).toBe('shadow');

      // Rollback ordering invariant: run the shadow sidecar BEFORE re-enabling
      // the legacy tailer (SREM). Reversing it would let both publish — dups.
      const runOrder = containerRunRnsquadjs.mock.invocationCallOrder[0]!;
      const sremOrder = srem.mock.invocationCallOrder[0]!;
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
      const captured: Array<{ url: string; config?: Record<string, unknown> }> = [];
      const app = Fastify({ logger: false });
      app.setValidatorCompiler(validatorCompiler);
      app.setSerializerCompiler(serializerCompiler);
      app.addHook('onRoute', (route) => {
        captured.push({ url: route.url, config: route.config as Record<string, unknown> });
      });
      await app.register(serverRnsquadjsRoutes);
      await app.ready();

      const route = captured.find((r) => r.url === '/api/v1/servers/:id/rnsquadjs');
      expect(route?.config?.permissions).toEqual(['server:stop']);
      expect(route?.config?.audit).toEqual({
        action: 'server.rnsquadjs.cutover',
        resource: 'server',
      });

      await app.close();
    });
  });
});
