import http from 'node:http';
import type { AddressInfo } from 'node:net';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import Fastify from 'fastify';
import {
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
} from 'fastify-type-provider-zod';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// `app.inject()` (light-my-request) and `undici` both silently canonicalize
// `..` segments before the request reaches the server, so neither client can
// distinguish the vulnerable @fastify/static@9.1.3 from the patched 10.1.2.
// Passing a URL *string* to node:http has the same problem — http.get/request
// parse a string argument with WHATWG `URL`, whose parser also removes dot
// segments before the request is ever sent. Using the options-object form
// (hostname/port/path) instead bypasses that parser and puts the raw `..` on
// the wire, so this is a real end-to-end probe of @fastify/static's guard.
function get(path: string): Promise<{ statusCode: number }> {
  return new Promise((resolve, reject) => {
    http
      .get({ hostname: '127.0.0.1', port, path }, (res) => {
        res.resume();
        res.on('end', () => resolve({ statusCode: res.statusCode ?? 0 }));
      })
      .on('error', reject);
  });
}

let port: number;

describe('swagger-ui static asset path traversal (CVE-2026-15074)', () => {
  const app = Fastify({ logger: false });

  beforeAll(async () => {
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    await app.register(swagger, {
      openapi: { info: { title: 'swagger-static-test', version: '0.0.0' } },
      transform: jsonSchemaTransform,
    });
    await app.register(swaggerUi, { routePrefix: '/api/docs' });
    await app.listen({ port: 0, host: '127.0.0.1' });

    const address = app.server.address() as AddressInfo;
    port = address.port;
  });

  afterAll(() => app.close());

  it('serves a real swagger-ui asset (guards against the fastify-swagger-ui#267/#268 regression class)', async () => {
    const res = await get('/api/docs/static/index.css');
    expect(res.statusCode).toBe(200);
  });

  it('rejects a literal dot-dot segment (CVE-2026-15074)', async () => {
    const res = await get('/api/docs/static/a/../index.css');
    expect(res.statusCode).toBe(403);
  });

  it('rejects the percent-encoded dot-dot variant (CVE-2026-15074)', async () => {
    const res = await get('/api/docs/static/a/%2E%2E/index.css');
    expect(res.statusCode).toBe(403);
  });
});
