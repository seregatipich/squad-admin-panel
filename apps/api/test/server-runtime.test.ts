import { describe, expect, it, vi } from 'vitest';
import {
  containerOnlyPreHandler,
  EXTERNAL_SERVER_ERROR,
  isExternalRuntime,
  rejectExternalServer,
} from '../src/lib/server-runtime.js';

const UUID = '019dbac8-ceb0-77ab-859b-bfa9a282ee2c';

function makeReply() {
  const reply = {
    statusCode: 200,
    body: undefined as unknown,
    code(status: number) {
      this.statusCode = status;
      return this;
    },
    send(body: unknown) {
      this.body = body;
      return this;
    },
  };
  return reply;
}

function makeReq(id: unknown) {
  return { params: { id }, log: { warn: vi.fn() } };
}

function appWith(runtime: string | null) {
  return {
    db: {
      query: {
        servers: {
          findFirst: vi.fn(async () => (runtime === null ? undefined : { runtime })),
        },
      },
    },
  };
}

describe('isExternalRuntime / rejectExternalServer', () => {
  it('recognises only the external runtime', () => {
    expect(isExternalRuntime('external')).toBe(true);
    expect(isExternalRuntime('container')).toBe(false);
    expect(isExternalRuntime(null)).toBe(false);
    expect(isExternalRuntime(undefined)).toBe(false);
  });

  it('rejectExternalServer sets 409 and returns the shared body', () => {
    const reply = makeReply();
    // biome-ignore lint/suspicious/noExplicitAny: minimal reply double
    const body = rejectExternalServer(reply as any);
    expect(reply.statusCode).toBe(409);
    expect(body).toBe(EXTERNAL_SERVER_ERROR);
  });
});

describe('containerOnlyPreHandler', () => {
  it('answers 409 external_server for an external row and leaves the rest alone', async () => {
    const app = appWith('external');
    // biome-ignore lint/suspicious/noExplicitAny: minimal fastify doubles
    const hook = containerOnlyPreHandler(app as any);
    const reply = makeReply();
    // biome-ignore lint/suspicious/noExplicitAny: minimal fastify doubles
    await hook(makeReq(UUID) as any, reply as any);
    expect(reply.statusCode).toBe(409);
    expect(reply.body).toEqual(EXTERNAL_SERVER_ERROR);
  });

  it('passes a container row, an unknown id and a non-uuid param through untouched', async () => {
    for (const [app, id] of [
      [appWith('container'), UUID],
      [appWith(null), UUID],
      [appWith('external'), 'not-a-uuid'],
    ] as const) {
      // biome-ignore lint/suspicious/noExplicitAny: minimal fastify doubles
      const hook = containerOnlyPreHandler(app as any);
      const reply = makeReply();
      // biome-ignore lint/suspicious/noExplicitAny: minimal fastify doubles
      await hook(makeReq(id) as any, reply as any);
      expect(reply.statusCode).toBe(200);
      expect(reply.body).toBeUndefined();
    }
    // A non-uuid never reaches the database.
    const app = appWith('external');
    // biome-ignore lint/suspicious/noExplicitAny: minimal fastify doubles
    await containerOnlyPreHandler(app as any)(makeReq('nope') as any, makeReply() as any);
    expect(app.db.query.servers.findFirst).not.toHaveBeenCalled();
  });

  it('fails open when the lookup itself throws, so a handshake is not turned into a 500', async () => {
    // Regression: test/install-ws.test.ts decorates `db` with `{}`; the guard
    // must not break the install progress WebSocket route there.
    const app = { db: {} };
    // biome-ignore lint/suspicious/noExplicitAny: minimal fastify doubles
    const hook = containerOnlyPreHandler(app as any);
    const req = makeReq(UUID);
    const reply = makeReply();
    // biome-ignore lint/suspicious/noExplicitAny: minimal fastify doubles
    await expect(hook(req as any, reply as any)).resolves.toBeUndefined();
    expect(reply.statusCode).toBe(200);
    expect(req.log.warn).toHaveBeenCalledTimes(1);
  });
});
