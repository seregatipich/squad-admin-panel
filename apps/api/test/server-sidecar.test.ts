import type { BridgeClient } from '@squad/bridge-client';
import type { DatabaseClient } from '@squad/db';
import { RNSQUADJS_CUTOVER_SET, SQUADJS2_ENGINE_SET } from '@squad/shared-config';
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import type Redis from 'ioredis';
import { beforeEach, describe, expect, it, type Mock, vi } from 'vitest';

// Both config writers perform real fs writes under /run; stub them so route
// tests never touch the host runtime dir. Env builders and naming stay real so
// the asserted env and container names are the production shape.
vi.mock('../src/lib/squadjs2.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/squadjs2.js')>()),
  writeSquadjs2Config: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../src/lib/rnsquadjs.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/rnsquadjs.js')>()),
  writeSidecarConfig: vi.fn().mockResolvedValue(undefined),
}));

import { writeSidecarConfig } from '../src/lib/rnsquadjs.js';
import { writeSquadjs2Config } from '../src/lib/squadjs2.js';
import { CUTOVER_TICK_MS } from '../src/routes/server-rnsquadjs.js';
import serverSidecarRoutes, { parseSidecarStatus } from '../src/routes/server-sidecar.js';

const SERVER_ID = '0190a000-0000-7000-8000-000000000001';
const URL = `/api/v1/servers/${SERVER_ID}/sidecar`;

interface RedisStub {
  sadd: Mock;
  srem: Mock;
  sismember: Mock;
  mget?: Mock;
}

interface BridgeStub {
  containerRm: Mock;
  containerRunRnsquadjs: Mock;
  containerRunSquadjs2: Mock;
  directoryDelete: Mock;
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

function makeBridge(overrides: Partial<BridgeStub> = {}): BridgeStub {
  return {
    containerRm: vi.fn().mockResolvedValue({ status: 'ok' }),
    containerRunRnsquadjs: vi.fn().mockResolvedValue({ container_id: 'rns-cid' }),
    containerRunSquadjs2: vi.fn().mockResolvedValue({ container_id: 'sjs2-cid' }),
    directoryDelete: vi.fn().mockResolvedValue({ removed: true }),
    ...overrides,
  };
}

function makeRedis(overrides: Partial<RedisStub> = {}): RedisStub {
  return {
    sadd: vi.fn().mockResolvedValue(1),
    srem: vi.fn().mockResolvedValue(1),
    sismember: vi.fn().mockResolvedValue(0),
    mget: vi.fn().mockResolvedValue([null, null, null, null]),
    ...overrides,
  };
}

async function buildApp(opts: {
  findFirst?: Mock;
  redis?: RedisStub;
  bridge?: BridgeStub;
}): Promise<{ app: FastifyInstance; errorLog: Mock; redis: RedisStub; bridge: BridgeStub }> {
  const { logger, error } = makeSpyLogger();
  const redis = opts.redis ?? makeRedis();
  const bridge = opts.bridge ?? makeBridge();
  const app = Fastify({ loggerInstance: logger });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.decorate('db', {
    query: {
      servers: { findFirst: opts.findFirst ?? vi.fn().mockResolvedValue({ id: SERVER_ID }) },
    },
  } as unknown as DatabaseClient);
  app.decorate('redis', redis as unknown as Redis);
  app.decorate('bridge', bridge as unknown as BridgeClient);
  await app.register(serverSidecarRoutes);
  await app.ready();
  return { app, errorLog: error, redis, bridge };
}

const post = (app: FastifyInstance, body: { engine: string; mode: string }) =>
  app.inject({
    method: 'POST',
    url: URL,
    headers: { 'content-type': 'application/json' },
    payload: body,
  });

beforeEach(() => {
  vi.clearAllMocks();
});

describe('parseSidecarStatus', () => {
  it('decodes the sidecar payload into snake_case', () => {
    expect(
      parseSidecarStatus('{"state":"connected","lastChange":"2026-09-08T03:00:00.000Z"}'),
    ).toEqual({ state: 'connected', last_change: '2026-09-08T03:00:00.000Z' });
  });

  it('treats an absent, unparseable or unexpected payload as no signal', () => {
    expect(parseSidecarStatus(null)).toBeNull();
    expect(parseSidecarStatus('not json')).toBeNull();
    expect(parseSidecarStatus('{"state":"weird"}')).toBeNull();
  });
});

describe('GET /servers/:id/sidecar', () => {
  it('404s for an unknown server', async () => {
    const { app } = await buildApp({ findFirst: vi.fn().mockResolvedValue(undefined) });
    const res = await app.inject({ method: 'GET', url: URL });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it('reports the legacy parser when nothing is running', async () => {
    const { app } = await buildApp({});
    const res = await app.inject({ method: 'GET', url: URL });
    expect(res.json()).toEqual({
      server_id: SERVER_ID,
      engine: 'rnsquadjs',
      mode: 'legacy',
      cutover: false,
      status: null,
    });
    await app.close();
  });

  it('reports squadjs2 for a member of the engine set', async () => {
    const redis = makeRedis({
      sismember: vi.fn(async (key: string) => (key === SQUADJS2_ENGINE_SET ? 1 : 0)),
    });
    const { app } = await buildApp({ redis });
    expect((await app.inject({ method: 'GET', url: URL })).json().engine).toBe('squadjs2');
    await app.close();
  });

  it('reads the engine-neutral status key first', async () => {
    const redis = makeRedis({
      mget: vi
        .fn()
        .mockResolvedValue([
          null,
          '{"state":"connected","lastChange":"new"}',
          null,
          '{"state":"disconnected","lastChange":"old"}',
        ]),
    });
    const { app } = await buildApp({ redis });
    const body = (await app.inject({ method: 'GET', url: URL })).json();
    expect(body.mode).toBe('shadow');
    expect(body.status).toEqual({ state: 'connected', last_change: 'new' });
    await app.close();
  });

  it('falls back to the legacy RNSquadJS status key', async () => {
    const redis = makeRedis({
      mget: vi
        .fn()
        .mockResolvedValue([null, null, null, '{"state":"connected","lastChange":"legacy"}']),
    });
    const { app } = await buildApp({ redis });
    const body = (await app.inject({ method: 'GET', url: URL })).json();
    expect(body.mode).toBe('shadow');
    expect(body.status).toEqual({ state: 'connected', last_change: 'legacy' });
    await app.close();
  });

  it('reports production from the cutover set even without a status key', async () => {
    const redis = makeRedis({
      sismember: vi.fn(async (key: string) => (key === RNSQUADJS_CUTOVER_SET ? 1 : 0)),
    });
    const { app } = await buildApp({ redis });
    const body = (await app.inject({ method: 'GET', url: URL })).json();
    expect(body).toMatchObject({ mode: 'production', cutover: true, status: null });
    await app.close();
  });
});

describe('POST /servers/:id/sidecar — engine switch', () => {
  it('404s for an unknown server without touching Redis', async () => {
    const { app, redis } = await buildApp({ findFirst: vi.fn().mockResolvedValue(undefined) });
    const res = await post(app, { engine: 'squadjs2', mode: 'shadow' });
    expect(res.statusCode).toBe(404);
    expect(redis.sadd).not.toHaveBeenCalled();
    await app.close();
  });

  it('rejects an unknown engine', async () => {
    const { app } = await buildApp({});
    expect((await post(app, { engine: 'nonsense', mode: 'shadow' })).statusCode).toBe(400);
    await app.close();
  });

  it('adds the server to the engine set and launches SquadJS2 in shadow mode', async () => {
    const { app, redis, bridge } = await buildApp({});

    const res = await post(app, { engine: 'squadjs2', mode: 'shadow' });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      server_id: SERVER_ID,
      engine: 'squadjs2',
      mode: 'shadow',
      container_id: 'sjs2-cid',
    });
    expect(redis.sadd).toHaveBeenCalledWith(SQUADJS2_ENGINE_SET, SERVER_ID);
    expect(writeSquadjs2Config).toHaveBeenCalledWith(expect.anything(), SERVER_ID, 'shadow');
    expect(bridge.containerRunSquadjs2).toHaveBeenCalledWith({
      server_id: SERVER_ID,
      env: { SERVER_ID, LOG_FILE: '/squad/Logs/SquadGame.log' },
    });
    await app.close();
  });

  it('removes the server from the engine set when switching back to RNSquadJS', async () => {
    const { app, redis, bridge } = await buildApp({});

    const res = await post(app, { engine: 'rnsquadjs', mode: 'shadow' });

    expect(res.json().engine).toBe('rnsquadjs');
    expect(redis.srem).toHaveBeenCalledWith(SQUADJS2_ENGINE_SET, SERVER_ID);
    expect(writeSidecarConfig).toHaveBeenCalled();
    expect(bridge.containerRunRnsquadjs).toHaveBeenCalled();
    await app.close();
  });

  // Single-writer invariant: two sidecars publishing to `:shadow` would double
  // every event and make the parity gate meaningless.
  it('stops both engines before launching the target one', async () => {
    const { app, bridge } = await buildApp({});

    await post(app, { engine: 'squadjs2', mode: 'shadow' });

    const removed = bridge.containerRm.mock.calls.map((call) => call[0].name).sort();
    expect(removed).toEqual([`rnsquadjs-${SERVER_ID}`, `squadjs2-${SERVER_ID}`]);
    const lastRm = Math.max(...bridge.containerRm.mock.invocationCallOrder);
    expect(bridge.containerRunSquadjs2.mock.invocationCallOrder[0]).toBeGreaterThan(lastRm);
    await app.close();
  });

  it('deletes the abandoned engine config dir so the RCON password does not linger', async () => {
    const { app, bridge } = await buildApp({});

    await post(app, { engine: 'squadjs2', mode: 'shadow' });

    expect(bridge.directoryDelete).toHaveBeenCalledWith({
      path: `/run/squad-panel/rnsquadjs/${SERVER_ID}`,
    });
    await app.close();
  });

  it('tolerates a failing directory purge', async () => {
    const bridge = makeBridge({ directoryDelete: vi.fn().mockRejectedValue(new Error('nope')) });
    const { app } = await buildApp({ bridge });

    expect((await post(app, { engine: 'squadjs2', mode: 'shadow' })).statusCode).toBe(200);
    await app.close();
  });

  it('leaves the cutover set clear after a shadow switch', async () => {
    const { app, redis } = await buildApp({});
    await post(app, { engine: 'squadjs2', mode: 'shadow' });
    expect(redis.srem).toHaveBeenCalledWith(RNSQUADJS_CUTOVER_SET, SERVER_ID);
    await app.close();
  });

  it('still clears the cutover set when the relaunch throws', async () => {
    const bridge = makeBridge({
      containerRunSquadjs2: vi.fn().mockRejectedValue(new Error('docker down')),
    });
    const { app, redis } = await buildApp({ bridge });

    expect((await post(app, { engine: 'squadjs2', mode: 'shadow' })).statusCode).toBe(500);
    expect(redis.srem).toHaveBeenCalledWith(RNSQUADJS_CUTOVER_SET, SERVER_ID);
    await app.close();
  });
});

describe('POST /servers/:id/sidecar — production sequencing', () => {
  it('returns 202 immediately and launches after the reconcile tick', async () => {
    const { app, redis, bridge } = await buildApp({
      redis: makeRedis({ sismember: vi.fn().mockResolvedValue(1) }),
    });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

    const res = await post(app, { engine: 'squadjs2', mode: 'production' });

    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({
      server_id: SERVER_ID,
      engine: 'squadjs2',
      mode: 'production',
      status: 'switching',
    });
    expect(redis.sadd).toHaveBeenCalledWith(RNSQUADJS_CUTOVER_SET, SERVER_ID);
    expect(bridge.containerRunSquadjs2).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(CUTOVER_TICK_MS + 10);
    expect(writeSquadjs2Config).toHaveBeenCalledWith(expect.anything(), SERVER_ID, 'production');
    expect(bridge.containerRunSquadjs2).toHaveBeenCalledTimes(1);

    vi.useRealTimers();
    await app.close();
  });

  it('aborts the launch when a rollback superseded it during the wait', async () => {
    const sismember = vi.fn(async (key: string) => (key === RNSQUADJS_CUTOVER_SET ? 0 : 0));
    const { app, bridge } = await buildApp({ redis: makeRedis({ sismember }) });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

    await post(app, { engine: 'squadjs2', mode: 'production' });
    await vi.advanceTimersByTimeAsync(CUTOVER_TICK_MS + 10);

    expect(bridge.containerRunSquadjs2).not.toHaveBeenCalled();
    vi.useRealTimers();
    await app.close();
  });

  it('rolls the cutover set back to legacy when the deferred launch fails', async () => {
    const bridge = makeBridge({
      containerRunSquadjs2: vi.fn().mockRejectedValue(new Error('docker down')),
    });
    const { app, redis, errorLog } = await buildApp({
      redis: makeRedis({ sismember: vi.fn().mockResolvedValue(1) }),
      bridge,
    });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

    await post(app, { engine: 'squadjs2', mode: 'production' });
    await vi.advanceTimersByTimeAsync(CUTOVER_TICK_MS + 10);

    expect(redis.srem).toHaveBeenCalledWith(RNSQUADJS_CUTOVER_SET, SERVER_ID);
    expect(errorLog).toHaveBeenCalled();
    vi.useRealTimers();
    await app.close();
  });
});

describe('sidecar route registration', () => {
  it('declares the permissions and audit action the panel expects', async () => {
    const captured: { url: string; method: string; config?: Record<string, unknown> }[] = [];
    const app = Fastify({ logger: false });
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    app.addHook('onRoute', (route) => {
      for (const method of Array.isArray(route.method) ? route.method : [route.method]) {
        captured.push({ url: route.url, method, config: route.config as Record<string, unknown> });
      }
    });
    await app.register(serverSidecarRoutes);
    await app.ready();
    await app.close();

    const get = captured.find((r) => r.method === 'GET');
    const postRoute = captured.find((r) => r.method === 'POST');
    expect(get?.url).toBe('/api/v1/servers/:id/sidecar');
    expect(get?.config?.permissions).toEqual(['server:view']);
    expect(postRoute?.config?.permissions).toEqual(['server:stop']);
    expect(postRoute?.config?.audit).toEqual({
      action: 'server.sidecar.switch',
      resource: 'server',
    });
  });
});
