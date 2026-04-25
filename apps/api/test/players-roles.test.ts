import cookie from '@fastify/cookie';
import * as schema from '@squad/db/schema';
import {
  organizationMembers,
  organizations,
  playerRoleAssignments,
  players,
  roles,
} from '@squad/db/schema';
import { seedSystemRoles } from '@squad/db/seed';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import Redis from 'ioredis';
import postgres from 'postgres';
import { v7 as uuidv7 } from 'uuid';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createSession } from '../src/lib/sessions.js';
import auditPlugin from '../src/plugins/audit.js';
import authPlugin, { SESSION_COOKIE } from '../src/plugins/auth.js';
import playerRoutes from '../src/routes/players.js';
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
  await app.register(authPlugin);
  await app.register(auditPlugin);
  await app.register(playerRoutes);
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

async function seedOwner(
  // biome-ignore lint/suspicious/noExplicitAny: drizzle test handle
  db: any,
  redis: Redis,
  steamId64: bigint,
): Promise<{ token: string; orgId: string; ownerRoleId: string; modRoleId: string }> {
  const orgId = uuidv7();
  await db.insert(organizations).values({ id: orgId, name: 'T', slug: 't' });
  await seedSystemRoles(db, orgId);
  const allRoles = await db.select().from(roles).where(eq(roles.orgId, orgId));
  // biome-ignore lint/suspicious/noExplicitAny: dynamic seeded rows
  // biome-ignore lint/style/noNonNullAssertion: Owner always exists after seedSystemRoles
  const ownerRole = allRoles.find((r: any) => r.name === 'Owner')!;
  // biome-ignore lint/suspicious/noExplicitAny: dynamic seeded rows
  const modRole = allRoles.find((r: any) => r.name === 'Moderator');
  // biome-ignore lint/suspicious/noExplicitAny: dynamic seeded rows
  const fallbackRole = allRoles.find((r: any) => r.name !== 'Owner');
  // biome-ignore lint/style/noNonNullAssertion: at least one non-Owner role always exists after seedSystemRoles
  const otherRole = modRole ?? fallbackRole!;
  await db.insert(players).values({
    steamId64,
    canonicalName: 'Owner',
    canonicalNameNormalized: 'owner',
  });
  await db.insert(playerRoleAssignments).values({ steamId64, roleId: ownerRole.id });
  await db.insert(organizationMembers).values({ steamId64, orgId, primaryRoleId: ownerRole.id });
  const session = await createSession(db, redis, {
    steamId64,
    ip: null,
    userAgent: 'test',
    ttlMs: 21600 * 1000,
  });
  return {
    token: session.token,
    orgId,
    ownerRoleId: ownerRole.id,
    modRoleId: otherRole.id,
  };
}

describe('player roles endpoints', () => {
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

  it('POST /:steamId/roles assigns and DELETE removes', async () => {
    const owner = await seedOwner(h.db, h.redis, 76561198000000800n);
    const target = 76561198000000801n;
    await h.db.insert(players).values({
      steamId64: target,
      canonicalName: 'Target',
      canonicalNameNormalized: 'target',
    });
    const assign = await h.app.inject({
      method: 'POST',
      url: `/api/v1/players/${target}/roles`,
      headers: { 'content-type': 'application/json' },
      payload: { role_id: owner.modRoleId },
      cookies: { [SESSION_COOKIE]: owner.token },
    });
    expect(assign.statusCode).toBe(200);
    const after = await h.db
      .select()
      .from(playerRoleAssignments)
      .where(eq(playerRoleAssignments.steamId64, target));
    expect(after.length).toBe(1);

    const remove = await h.app.inject({
      method: 'DELETE',
      url: `/api/v1/players/${target}/roles/${owner.modRoleId}`,
      cookies: { [SESSION_COOKIE]: owner.token },
    });
    expect(remove.statusCode).toBe(200);
    const final = await h.db
      .select()
      .from(playerRoleAssignments)
      .where(eq(playerRoleAssignments.steamId64, target));
    expect(final.length).toBe(0);
  });

  it('cannot remove the last Owner', async () => {
    const owner = await seedOwner(h.db, h.redis, 76561198000000900n);
    const res = await h.app.inject({
      method: 'DELETE',
      url: `/api/v1/players/76561198000000900/roles/${owner.ownerRoleId}`,
      cookies: { [SESSION_COOKIE]: owner.token },
    });
    expect(res.statusCode).toBe(409);
    const body = res.json() as { error: string };
    expect(body.error).toBe('cannot_remove_last_owner');
    const remaining = await h.db
      .select()
      .from(playerRoleAssignments)
      .where(eq(playerRoleAssignments.roleId, owner.ownerRoleId));
    expect(remaining.length).toBe(1);
  });

  it('GET /:steamId/roles lists current assignments', async () => {
    const owner = await seedOwner(h.db, h.redis, 76561198000001000n);
    const res = await h.app.inject({
      method: 'GET',
      url: `/api/v1/players/76561198000001000/roles`,
      cookies: { [SESSION_COOKIE]: owner.token },
    });
    expect(res.statusCode).toBe(200);
    const list = res.json() as Array<{ role_id: string; name: string }>;
    expect(list.length).toBe(1);
    expect(list[0]?.name).toBe('Owner');
  });

  it('rejects non-Owner caller without user:manage_roles permission', async () => {
    const owner = await seedOwner(h.db, h.redis, 76561198000001100n);
    const someone = 76561198000001101n;
    await h.db.insert(players).values({
      steamId64: someone,
      canonicalName: 'Nobody',
      canonicalNameNormalized: 'nobody',
    });
    const session = await createSession(h.db, h.redis, {
      steamId64: someone,
      ip: null,
      userAgent: 'test',
      ttlMs: 21600 * 1000,
    });
    const res = await h.app.inject({
      method: 'POST',
      url: `/api/v1/players/${someone}/roles`,
      headers: { 'content-type': 'application/json' },
      payload: { role_id: owner.modRoleId },
      cookies: { [SESSION_COOKIE]: session.token },
    });
    expect([401, 403]).toContain(res.statusCode);
  });
});
