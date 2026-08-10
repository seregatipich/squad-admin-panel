/**
 * GET /api/v1/depot/progress/ws — shared SteamCMD depot-update progress
 * stream, watched by both the per-server "update game" button and the
 * fleet-wide depot update modal (both publish into the same
 * `depot:progress` Redis stream; see apps/api/src/lib/depot-progress.ts).
 *
 * Uses a real Redis connection (not a stub) because the route's
 * correctness hinges on actual Stream semantics: xrange backfill ordering,
 * blocking xread live-tail, and telling a stale backfilled 'done' sentinel
 * apart from a live one.
 */
import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import Redis from 'ioredis';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { publishDepotProgressDone, publishDepotProgressLine } from '../src/lib/depot-progress.js';
import depotRoutes from '../src/routes/depot.js';
import { hostRedisUrl } from './integration/isolated-db.js';

let app: ReturnType<typeof Fastify>;
let port: number;
let redis: Redis;

beforeAll(async () => {
  redis = new Redis(hostRedisUrl());
  app = Fastify({ logger: false });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  // biome-ignore lint/suspicious/noExplicitAny: test fixture
  (app as any).decorate('db', {});
  // biome-ignore lint/suspicious/noExplicitAny: test fixture
  (app as any).decorate('redis', redis);
  // biome-ignore lint/suspicious/noExplicitAny: test fixture
  (app as any).decorate('bridge', {});
  // biome-ignore lint/suspicious/noExplicitAny: test fixture
  (app as any).decorate('makeBridgeClient', () => ({}));
  await app.register(await import('@fastify/websocket').then((m) => m.default));
  await app.register(depotRoutes);
  await app.listen({ port: 0, host: '127.0.0.1' });
  const addr = app.server.address();
  if (!addr || typeof addr === 'string') throw new Error('no port');
  port = addr.port;
});

beforeEach(async () => {
  await redis.del('depot:progress', 'depot:updating', 'depot:last_update');
});

afterEach(async () => {
  await redis.del('depot:progress', 'depot:updating', 'depot:last_update');
});

afterAll(async () => {
  await app.close();
  await redis.quit();
});

function connect(): { ws: WebSocket; frames: unknown[] } {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/api/v1/depot/progress/ws`);
  const frames: unknown[] = [];
  ws.on('message', (raw) => frames.push(JSON.parse(raw.toString())));
  return { ws, frames };
}

async function waitFor(pred: () => boolean, timeoutMs = 2000) {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timeout');
    await new Promise((r) => setTimeout(r, 10));
  }
}

function waitForClose(ws: WebSocket): Promise<void> {
  if (ws.readyState === WebSocket.CLOSED) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      ws.off('close', onClose);
      ws.off('error', onError);
    };
    const onClose = () => {
      cleanup();
      resolve();
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    ws.once('close', onClose);
    ws.once('error', onError);
  });
}

describe('GET /api/v1/depot/progress/ws', () => {
  it('backfills existing lines, streams live lines, and closes on a live done sentinel', async () => {
    await publishDepotProgressLine(redis, 'stdout', 'buffered line 1');
    await redis.set('depot:updating', new Date().toISOString(), 'EX', 3600);

    const { ws, frames } = connect();
    await new Promise<void>((resolve) => ws.on('open', () => resolve()));
    await waitFor(() =>
      frames.some((f) => (f as { backfill_complete?: boolean }).backfill_complete === true),
    );

    const closed = waitForClose(ws);
    await publishDepotProgressLine(redis, 'stdout', 'live line 2');
    await publishDepotProgressDone(redis, 'done');
    await closed;

    const messages = frames
      .map((f) => (f as { message?: string }).message)
      .filter((m): m is string => typeof m === 'string');
    expect(messages).toEqual(['buffered line 1', 'live line 2']);

    const last = frames.at(-1) as { done?: boolean; final?: string };
    expect(last.done).toBe(true);
    expect(last.final).toBe('done');
  });

  it('forwards a stale backfilled done sentinel without treating it as terminal', async () => {
    // Simulates history: a previous run finished, then a new one started
    // and is still producing lines when this client connects.
    await publishDepotProgressLine(redis, 'stdout', 'old run line');
    await publishDepotProgressDone(redis, 'done');
    await publishDepotProgressLine(redis, 'stdout', 'new run line');
    await redis.set('depot:updating', new Date().toISOString(), 'EX', 3600);

    const { ws, frames } = connect();
    await new Promise<void>((resolve) => ws.on('open', () => resolve()));
    await waitFor(() =>
      frames.some((f) => (f as { backfill_complete?: boolean }).backfill_complete === true),
    );

    // The stale done sentinel was forwarded but must not have closed the
    // socket — it's still open, waiting for the live tail.
    expect(ws.readyState).toBe(WebSocket.OPEN);
    const doneFramesSoFar = frames.filter((f) => (f as { done?: boolean }).done).length;
    expect(doneFramesSoFar).toBe(1);

    const closed = waitForClose(ws);
    await publishDepotProgressDone(redis, 'error', 'boom');
    await closed;

    const last = frames.at(-1) as { done?: boolean; final?: string; error?: string };
    expect(last).toEqual({ done: true, final: 'error', error: 'boom' });
  });

  it('synthesizes an immediate done frame from depot:last_update when idle (ok)', async () => {
    await redis.set(
      'depot:last_update',
      JSON.stringify({ finished_at: new Date().toISOString(), status: 'ok' }),
    );

    const { ws, frames } = connect();
    await waitForClose(ws);

    const last = frames.at(-1) as { done?: boolean; final?: string };
    expect(last).toEqual({ done: true, final: 'done' });
  });

  it('synthesizes an immediate done frame from depot:last_update when idle (failed)', async () => {
    await redis.set(
      'depot:last_update',
      JSON.stringify({
        finished_at: new Date().toISOString(),
        status: 'failed',
        error: 'disk full',
      }),
    );

    const { ws, frames } = connect();
    await waitForClose(ws);

    const last = frames.at(-1) as { done?: boolean; final?: string; error?: string };
    expect(last).toEqual({ done: true, final: 'error', error: 'disk full' });
  });

  it('stays open with no synthesized frame when nothing has ever run', async () => {
    const { ws, frames } = connect();
    await new Promise<void>((resolve) => ws.on('open', () => resolve()));
    await waitFor(() =>
      frames.some((f) => (f as { backfill_complete?: boolean }).backfill_complete === true),
    );
    await new Promise((r) => setTimeout(r, 100));
    expect(ws.readyState).toBe(WebSocket.OPEN);
    expect(frames.some((f) => (f as { done?: boolean }).done)).toBe(false);
    ws.close();
  });
});
