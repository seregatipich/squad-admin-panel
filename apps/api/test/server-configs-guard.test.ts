/**
 * The config routes are split into sub-plugins (files, history, drift) that
 * the entry plugin registers after adding the container-only `preHandler`.
 * Fastify scopes hooks to a plugin and its children, so this guards the
 * inheritance: an external server (no container, no config tree) must be
 * refused with 409 `external_server` by every config route, whichever
 * sub-plugin owns it.
 */
import Fastify, { type FastifyInstance } from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { afterEach, describe, expect, it } from 'vitest';
import serverConfigRoutes from '../src/routes/server-configs.js';

const SERVER_ID = '0192f4a0-7c1e-7000-8000-000000000001';
const VERSION_ID = '0192f4a0-7c1e-7000-8000-000000000002';

let app: FastifyInstance | undefined;

async function buildApp(runtime: 'container' | 'external'): Promise<FastifyInstance> {
  const instance = Fastify({ logger: false });
  instance.setValidatorCompiler(validatorCompiler);
  instance.setSerializerCompiler(serializerCompiler);
  instance.decorate('db', {
    query: { servers: { findFirst: async () => ({ runtime }) } },
  } as never);
  await instance.register(serverConfigRoutes);
  await instance.ready();
  app = instance;
  return instance;
}

afterEach(async () => {
  await app?.close();
  app = undefined;
});

const CONFIG_ROUTES: Array<{ owner: string; method: 'GET' | 'PUT' | 'POST'; url: string }> = [
  { owner: 'files', method: 'GET', url: `/api/v1/servers/${SERVER_ID}/configs` },
  { owner: 'files', method: 'GET', url: `/api/v1/servers/${SERVER_ID}/configs/Server.cfg` },
  {
    owner: 'history',
    method: 'GET',
    url: `/api/v1/servers/${SERVER_ID}/configs/Server.cfg/history`,
  },
  {
    owner: 'history',
    method: 'GET',
    url: `/api/v1/servers/${SERVER_ID}/configs/Server.cfg/versions/${VERSION_ID}`,
  },
  { owner: 'drift', method: 'GET', url: `/api/v1/servers/${SERVER_ID}/configs/drift` },
  {
    owner: 'drift',
    method: 'GET',
    url: `/api/v1/servers/${SERVER_ID}/configs/Server.cfg/drift/diff`,
  },
];

describe('server config routes: container-only guard', () => {
  it.each(CONFIG_ROUTES)(
    'refuses an external server on $owner route $method $url',
    async ({ method, url }) => {
      const instance = await buildApp('external');
      const res = await instance.inject({ method, url });
      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ error: 'external_server' });
    },
  );

  it('does not refuse a container server at the guard', async () => {
    const instance = await buildApp('container');
    const res = await instance.inject({
      method: 'GET',
      url: `/api/v1/servers/${SERVER_ID}/configs/Server.cfg/history`,
    });
    expect(res.statusCode).not.toBe(409);
  });
});
