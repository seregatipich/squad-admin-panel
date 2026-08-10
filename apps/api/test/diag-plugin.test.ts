import type { Diag, DiagEvent } from '@squad/diag';
import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import diagPlugin from '../src/lib/diag.js';

function makeFakeRedis() {
  return {
    async xadd(..._args: unknown[]) {
      return '0-0';
    },
  };
}

describe('app.diag plugin', () => {
  it('decorates app with diag and per-request diag, threads request id from req.id', async () => {
    const app = Fastify({ logger: false });
    (app as unknown as { redis: unknown }).redis = makeFakeRedis();
    await app.register(diagPlugin);

    const captured: DiagEvent[] = [];
    (app as unknown as { diag: Diag }).diag.emit = async (ev) => {
      captured.push(ev);
    };

    app.route({
      method: 'GET',
      url: '/__test/diag',
      handler: async (req, reply) => {
        await req.diag.emit({
          component: 'api',
          kind: 'test.event',
          severity: 'info',
          message: 'hi',
        });
        return reply.send({ ok: true, id: req.id });
      },
    });

    const res = await app.inject({ method: 'GET', url: '/__test/diag' });

    expect(res.statusCode).toBe(200);
    expect(captured).toHaveLength(1);
    expect(captured[0]?.kind).toBe('test.event');
    expect(captured[0]?.component).toBe('api');
    expect(captured[0]?.severity).toBe('info');
    expect(typeof captured[0]?.requestId).toBe('string');
    expect(captured[0]?.requestId).not.toBe('');

    const body = res.json() as { id: string };
    expect(captured[0]?.requestId).toBe(body.id);

    await app.close();
  });

  it('preserves an explicit requestId set by the caller', async () => {
    const app = Fastify({ logger: false });
    (app as unknown as { redis: unknown }).redis = makeFakeRedis();
    await app.register(diagPlugin);

    const captured: DiagEvent[] = [];
    (app as unknown as { diag: Diag }).diag.emit = async (ev) => {
      captured.push(ev);
    };

    app.route({
      method: 'GET',
      url: '/__test/diag-explicit',
      handler: async (req, reply) => {
        await req.diag.emit({
          component: 'api',
          kind: 'test.event.explicit',
          severity: 'info',
          message: 'hi',
          requestId: 'caller-supplied-id',
        });
        return reply.send({ ok: true });
      },
    });

    const res = await app.inject({ method: 'GET', url: '/__test/diag-explicit' });

    expect(res.statusCode).toBe(200);
    expect(captured).toHaveLength(1);
    expect(captured[0]?.requestId).toBe('caller-supplied-id');

    await app.close();
  });
});
