import cookie from '@fastify/cookie';
import * as schema from '@squad/db/schema';
import { organizations, roles } from '@squad/db/schema';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import Redis from 'ioredis';
import postgres from 'postgres';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import setupRoutes from '../src/routes/setup.js';
import { createIsolatedSchema, makeFakeBridge, runMigrations } from './integration/harness.js';

const TEST_REDIS_URL = process.env.TEST_REDIS_URL ?? 'redis://127.0.0.1:6379/15';

async function buildApp(opts: { dbUrl: string }) {
  const app = Fastify({ logger: false });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  const sql = postgres(opts.dbUrl, { max: 4, onnotice: () => undefined });
  // biome-ignore lint/suspicious/noExplicitAny: integration test
  const db = drizzle(sql, { schema }) as any;
  const redis = new Redis(TEST_REDIS_URL);
  app.decorate('db', db);
  app.decorate('redis', redis);
  app.decorate('bridge', makeFakeBridge());
  // biome-ignore lint/suspicious/noExplicitAny: simplified test config
  const testConfig: any = {
    PANEL_PUBLIC_URL: 'https://panel.test',
    STEAM_API_KEY: '',
    SESSION_TTL_SECONDS: 21600,
    SESSION_TOUCH_THROTTLE_SECONDS: 60,
  };
  app.decorate('config', testConfig);
  await app.register(cookie, { secret: 'a'.repeat(48) });
  await app.register(setupRoutes);
  await app.ready();
  return {
    app,
    db,
    redis,
    cleanup: async () => {
      await app.close();
      await sql.end({ timeout: 5 });
      await redis.flushdb();
      await redis.quit();
    },
  };
}

describe('GET /api/v1/setup/check-env', () => {
  let schemaInfo: Awaited<ReturnType<typeof createIsolatedSchema>>;
  let h: Awaited<ReturnType<typeof buildApp>>;
  beforeEach(async () => {
    schemaInfo = await createIsolatedSchema();
    await runMigrations(schemaInfo.url);
    h = await buildApp({ dbUrl: schemaInfo.url });
  });
  afterEach(async () => {
    await h.cleanup();
    await schemaInfo.drop();
  });

  it('returns checks before init', async () => {
    const res = await h.app.inject({ method: 'GET', url: '/api/v1/setup/check-env' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { ok: boolean; checks: Record<string, { ok: boolean }> };
    expect(body.checks.bridge.ok).toBe(true);
    expect(body.checks.public_url.ok).toBe(true);
    expect(body.checks.steam_web_api.ok).toBe(false);
  });

  it('returns 410 if setup already complete', async () => {
    await h.db.insert(organizations).values({
      id: '01950000-0000-7000-8000-000000000001',
      name: 'X',
      slug: 'x',
      settings: { setup_complete: true },
    });
    const res = await h.app.inject({ method: 'GET', url: '/api/v1/setup/check-env' });
    expect(res.statusCode).toBe(410);
  });
});

describe('POST /api/v1/setup/init', () => {
  let schemaInfo: Awaited<ReturnType<typeof createIsolatedSchema>>;
  let h: Awaited<ReturnType<typeof buildApp>>;
  beforeEach(async () => {
    schemaInfo = await createIsolatedSchema();
    await runMigrations(schemaInfo.url);
    h = await buildApp({ dbUrl: schemaInfo.url });
  });
  afterEach(async () => {
    await h.cleanup();
    await schemaInfo.drop();
  });

  it('creates org + seeds Owner role + marks complete', async () => {
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/v1/setup/init',
      headers: { 'content-type': 'application/json' },
      payload: { name: 'Squad ABC' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { org_id: string; slug: string };
    expect(body.slug).toBe('squad-abc');
    const orgs = await h.db.select().from(organizations).where(eq(organizations.id, body.org_id));
    expect(orgs.length).toBe(1);
    expect((orgs[0]?.settings as Record<string, unknown>).setup_complete).toBe(true);
    const roleRows = await h.db.select().from(roles).where(eq(roles.orgId, body.org_id));
    expect(roleRows.length).toBeGreaterThan(0);
    const ownerRole = roleRows.find((r: { name: string }) => r.name === 'Owner');
    expect(ownerRole).toBeDefined();
  });

  it('rejects re-run with 410', async () => {
    await h.app.inject({
      method: 'POST',
      url: '/api/v1/setup/init',
      headers: { 'content-type': 'application/json' },
      payload: { name: 'A' },
    });
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/v1/setup/init',
      headers: { 'content-type': 'application/json' },
      payload: { name: 'B' },
    });
    expect(res.statusCode).toBe(410);
  });

  it('accepts explicit slug', async () => {
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/v1/setup/init',
      headers: { 'content-type': 'application/json' },
      payload: { name: 'Anything', slug: 'custom-slug' },
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { slug: string }).slug).toBe('custom-slug');
  });

  it('rejects invalid slug', async () => {
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/v1/setup/init',
      headers: { 'content-type': 'application/json' },
      payload: { name: 'A', slug: 'INVALID UPPER' },
    });
    expect(res.statusCode).toBe(400);
  });
});
