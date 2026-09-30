import type { Diag, DiagEvent } from '@squad/diag';
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import diagPlugin from '../src/lib/diag.js';
import errorDiagPlugin from '../src/plugins/error-diag.js';

function makeFakeRedis() {
  return {
    async xadd(..._args: unknown[]) {
      return '0-0';
    },
  };
}

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    const fn = cleanups.shift();
    if (fn) await fn().catch(() => undefined);
  }
});

async function buildApp(): Promise<{ app: ReturnType<typeof Fastify>; captured: DiagEvent[] }> {
  const app = Fastify({ logger: false });
  (app as unknown as { redis: unknown }).redis = makeFakeRedis();
  await app.register(diagPlugin);
  await app.register(errorDiagPlugin);

  const captured: DiagEvent[] = [];
  (app as unknown as { diag: Diag }).diag.emit = async (ev) => {
    captured.push(ev);
  };

  cleanups.push(async () => {
    await app.close();
  });

  return { app, captured };
}

describe('http error diag emits', () => {
  it('emits http.5xx when a route handler throws a 500', async () => {
    const { app, captured } = await buildApp();

    app.route({
      method: 'GET',
      url: '/__test/throw',
      handler: async () => {
        throw new Error('synthetic 500');
      },
    });

    const res = await app.inject({ method: 'GET', url: '/__test/throw' });
    expect(res.statusCode).toBe(500);

    const ev = captured.find((e) => e.kind === 'http.5xx');
    expect(ev).toBeDefined();
    expect(ev?.severity).toBe('error');
    expect(ev?.component).toBe('api');
    expect(typeof ev?.requestId).toBe('string');
    const payload = ev?.payload as {
      method: string;
      url: string;
      status: number;
      err: string;
      stack?: string;
    };
    expect(payload.method).toBe('GET');
    expect(payload.url).toBe('/__test/throw');
    expect(payload.status).toBe(500);
    expect(payload.err).toBe('synthetic 500');
    expect(typeof payload.stack).toBe('string');
    expect((payload.stack ?? '').length).toBeLessThanOrEqual(2000);
  });

  it('does not emit http.5xx for 4xx errors', async () => {
    const { app, captured } = await buildApp();

    app.route({
      method: 'GET',
      url: '/__test/forbidden',
      handler: async (_req: FastifyRequest, reply: FastifyReply) => {
        return reply.code(403).send({ error: 'forbidden' });
      },
    });

    app.route({
      method: 'GET',
      url: '/__test/notfound',
      handler: async () => {
        const err = new Error('not here') as Error & { statusCode: number };
        err.statusCode = 404;
        throw err;
      },
    });

    const r403 = await app.inject({ method: 'GET', url: '/__test/forbidden' });
    expect(r403.statusCode).toBe(403);

    const r404 = await app.inject({ method: 'GET', url: '/__test/notfound' });
    expect(r404.statusCode).toBe(404);

    expect(captured.find((e) => e.kind === 'http.5xx')).toBeUndefined();
  });

  it('maps the database last-Owner invariant to a stable 409 response', async () => {
    const { app, captured } = await buildApp();

    app.route({
      method: 'POST',
      url: '/__test/last-owner',
      handler: async () => {
        throw Object.assign(new Error('cannot_remove_last_owner'), {
          code: '23514',
          constraint_name: 'players_last_owner_guard',
        });
      },
    });

    const response = await app.inject({ method: 'POST', url: '/__test/last-owner' });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ error: 'cannot_remove_last_owner' });
    expect(captured.find((event) => event.kind === 'http.5xx')).toBeUndefined();
  });

  it('maps a wrapped last-Owner invariant error (err.cause) to a stable 409 response', async () => {
    const { app, captured } = await buildApp();

    app.route({
      method: 'POST',
      url: '/__test/last-owner-wrapped',
      handler: async () => {
        const driverError = Object.assign(new Error('cannot_remove_last_owner'), {
          code: '23514',
          constraint_name: 'players_last_owner_guard',
        });
        throw new Error('transaction failed', { cause: driverError });
      },
    });

    const response = await app.inject({ method: 'POST', url: '/__test/last-owner-wrapped' });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ error: 'cannot_remove_last_owner' });
    expect(captured.find((event) => event.kind === 'http.5xx')).toBeUndefined();
  });

  it('truncates the stack to 2000 characters', async () => {
    const { app, captured } = await buildApp();

    app.route({
      method: 'GET',
      url: '/__test/throw-long',
      handler: async () => {
        const err = new Error('long stack');
        err.stack = 'X'.repeat(5000);
        throw err;
      },
    });

    const res = await app.inject({ method: 'GET', url: '/__test/throw-long' });
    expect(res.statusCode).toBe(500);
    const ev = captured.find((e) => e.kind === 'http.5xx');
    expect(ev).toBeDefined();
    const stack = (ev?.payload as { stack?: string })?.stack ?? '';
    expect(stack.length).toBe(2000);
  });

  it('answers a 5xx with a generic body that never carries the error message (#37)', async () => {
    const { app, captured } = await buildApp();

    app.route({
      method: 'GET',
      url: '/__test/throw-query',
      handler: async () => {
        // drizzle-orm's DrizzleQueryError message embeds the SQL text and
        // its bound parameters.
        throw new Error(
          'Failed query: select "id" from "players" where "ip" = $1\nparams: 203.0.113.7',
        );
      },
    });

    const res = await app.inject({
      method: 'GET',
      url: '/__test/throw-query',
      headers: { 'x-request-id': 'req-generic-5xx' },
    });
    expect(res.statusCode).toBe(500);
    expect(res.body).not.toContain('Failed query');
    expect(res.body).not.toContain('203.0.113.7');
    expect(res.json()).toEqual({
      statusCode: 500,
      error: 'internal_error',
      requestId: expect.any(String),
    });
    // The detail stays server-side, in the diag event.
    const ev = captured.find((e) => e.kind === 'http.5xx');
    expect((ev?.payload as { err: string }).err).toContain('Failed query');
  });

  it('keeps the error message in 4xx responses', async () => {
    const { app } = await buildApp();

    app.route({
      method: 'GET',
      url: '/__test/conflict',
      handler: async () => {
        throw Object.assign(new Error('slug already taken'), { statusCode: 409 });
      },
    });

    const res = await app.inject({ method: 'GET', url: '/__test/conflict' });
    expect(res.statusCode).toBe(409);
    expect((res.json() as { message: string }).message).toBe('slug already taken');
  });
});

describe('unhandled promise rejections', () => {
  function rejectionListeners(): Array<(reason: unknown) => void> {
    return process.listeners('unhandledRejection') as Array<(reason: unknown) => void>;
  }

  it('reports the rejection, then exits the process with code 1 (#37)', async () => {
    const before = new Set(rejectionListeners());
    const { captured } = await buildApp();
    const added = rejectionListeners().filter((listener) => !before.has(listener));
    expect(added).toHaveLength(1);

    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    try {
      // Invoke the plugin's listener directly: emitting the real event would
      // also reach vitest's own handler and fail the run.
      added[0]?.(new Error('lost promise'));
      await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(1));
    } finally {
      exit.mockRestore();
    }
    const ev = captured.find((e) => e.kind === 'http.unhandled_rejection');
    expect(ev?.severity).toBe('fatal');
    expect(ev?.message).toContain('lost promise');
  });

  it('gives every app instance its own listener and removes it on close', async () => {
    const baseline = process.listenerCount('unhandledRejection');
    const first = await buildApp();
    const second = await buildApp();
    expect(process.listenerCount('unhandledRejection')).toBe(baseline + 2);

    await first.app.close();
    await second.app.close();
    expect(process.listenerCount('unhandledRejection')).toBe(baseline);
  });
});
