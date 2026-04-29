import type { Diag, DiagEvent } from '@squad/diag';
import Fastify from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
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
      handler: async (_req, reply) => {
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

  it('preserves Fastify default JSON error envelope on 5xx', async () => {
    const { app } = await buildApp();

    app.route({
      method: 'GET',
      url: '/__test/throw-shape',
      handler: async () => {
        throw new Error('shape error');
      },
    });

    const res = await app.inject({ method: 'GET', url: '/__test/throw-shape' });
    expect(res.statusCode).toBe(500);
    const body = res.json() as { statusCode: number; error: string; message: string };
    expect(body.statusCode).toBe(500);
    expect(body.message).toBe('shape error');
  });
});
