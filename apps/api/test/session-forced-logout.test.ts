import cookie from '@fastify/cookie';
import websocket from '@fastify/websocket';
import * as schema from '@squad/db/schema';
import { players, roles, sessions as sessionsTable } from '@squad/db/schema';
import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import Redis from 'ioredis';
import postgres from 'postgres';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import diagPlugin from '../src/lib/diag.js';
import { createSession, revokeAllForPlayer } from '../src/lib/sessions.js';
import authPlugin, { SESSION_COOKIE } from '../src/plugins/auth.js';
import liveBusPlugin, { type LiveEvent } from '../src/plugins/live-bus.js';
import authRoutes from '../src/routes/auth.js';
import liveRoutes from '../src/routes/live.js';
import roleMembersRoutes from '../src/routes/role-members.js';
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
  const testConfig = {
    PANEL_PUBLIC_URL: 'https://panel.test',
    STEAM_API_KEY: '',
    SESSION_TTL_SECONDS: 21600,
    SESSION_TOUCH_THROTTLE_SECONDS: 60,
  };
  // biome-ignore lint/suspicious/noExplicitAny: simplified test config
  app.decorate('config', testConfig as any);
  await app.register(cookie, { secret: 'a'.repeat(48) });
  await app.register(websocket);
  await app.register(diagPlugin);
  await app.register(liveBusPlugin);
  await app.register(authPlugin);
  await app.register(authRoutes);
  await app.register(roleMembersRoutes);
  await app.register(liveRoutes);
  await app.listen({ port: 0, host: '127.0.0.1' });
  const addr = app.server.address();
  if (!addr || typeof addr === 'string') throw new Error('no port');
  const port = addr.port;
  return {
    app,
    db,
    redis,
    sql,
    port,
    cleanup: async () => {
      await app.close();
      await sql.end({ timeout: 5 });
      await redis.flushdb();
      await redis.quit();
    },
  };
}

async function ownerRoleId(
  // biome-ignore lint/suspicious/noExplicitAny: drizzle test handle
  db: any,
): Promise<string> {
  const rows = await db
    .select({ id: roles.id })
    .from(roles)
    .where(and(eq(roles.name, 'Owner'), eq(roles.isSystemRole, true)))
    .limit(1);
  const id = rows[0]?.id;
  if (!id) throw new Error('Owner role missing — migrations not applied?');
  return id;
}

async function seedAuthedPlayer(
  // biome-ignore lint/suspicious/noExplicitAny: drizzle test handle
  db: any,
  redis: Redis,
  steamId64: bigint,
  roleId: string,
): Promise<{ token: string; sessionId: string; playerId: string }> {
  const [{ id: playerId }] = await db
    .insert(players)
    .values({
      steamId64,
      canonicalName: `P${steamId64}`,
      canonicalNameNormalized: `p${steamId64}`,
      roleId,
    })
    .returning({ id: players.id });
  const result = await createSession(db, redis, {
    playerId,
    ip: null,
    userAgent: 'test-ua',
    ttlMs: 21600 * 1000,
  });
  return { token: result.token, sessionId: result.session.id, playerId };
}

type Revoked = Extract<LiveEvent, { type: 'session.revoked' }>;

async function connectWs(
  port: number,
  token: string,
): Promise<{ ws: WebSocket; received: Revoked[] }> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/api/v1/ws/live`, {
    headers: { cookie: `${SESSION_COOKIE}=${token}` },
  });
  const received: Revoked[] = [];
  ws.on('message', (raw) => {
    const frame = JSON.parse(raw.toString()) as LiveEvent;
    if (frame.type === 'session.revoked') received.push(frame);
  });
  await new Promise<void>((resolve, reject) => {
    ws.on('open', () => resolve());
    ws.on('error', (err) => reject(err));
  });
  return { ws, received };
}

async function closeWs(ws: WebSocket): Promise<void> {
  ws.close();
  await new Promise<void>((resolve) => ws.on('close', () => resolve()));
}

async function waitFor(pred: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timeout');
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe('WebSocket forced-logout push on server-side revoke (AUTH-4)', () => {
  let schemaInfo: Awaited<ReturnType<typeof createIsolatedSchema>>;
  let h: Awaited<ReturnType<typeof buildApp>>;
  let roleId: string;

  beforeEach(async () => {
    schemaInfo = await createIsolatedSchema();
    await runMigrations(schemaInfo.url);
    h = await buildApp({ dbUrl: schemaInfo.url });
    roleId = await ownerRoleId(h.db);
  });
  afterEach(async () => {
    await h.cleanup();
    await schemaInfo.drop();
  });

  it('pushes session.revoked to the revoked player’s connected socket', async () => {
    const player = await seedAuthedPlayer(h.db, h.redis, 76561198000010001n, roleId);
    const { ws, received } = await connectWs(h.port, player.token);

    await revokeAllForPlayer(h.db, h.redis, player.playerId, h.app.liveBus);

    await waitFor(() => received.some((e) => e.data.session_id === player.sessionId));
    const event = received.find((e) => e.data.session_id === player.sessionId);
    expect(event?.data.player_id).toBe(player.playerId);

    // The revoke really killed the session server-side.
    const rows = await h.db
      .select()
      .from(sessionsTable)
      .where(eq(sessionsTable.playerId, player.playerId));
    expect(rows.length).toBe(0);
    await closeWs(ws);
  });

  it('targets only the revoked player, never another admin’s socket', async () => {
    const x = await seedAuthedPlayer(h.db, h.redis, 76561198000010002n, roleId);
    const y = await seedAuthedPlayer(h.db, h.redis, 76561198000010003n, roleId);
    const cx = await connectWs(h.port, x.token);
    const cy = await connectWs(h.port, y.token);

    await revokeAllForPlayer(h.db, h.redis, x.playerId, h.app.liveBus);
    await revokeAllForPlayer(h.db, h.redis, y.playerId, h.app.liveBus);

    // Both events land (proves each pipe works) — used to make the negative
    // assertion deterministic rather than wall-clock based.
    await waitFor(() => cx.received.some((e) => e.data.session_id === x.sessionId));
    await waitFor(() => cy.received.some((e) => e.data.session_id === y.sessionId));

    expect(cx.received.some((e) => e.data.session_id === y.sessionId)).toBe(false);
    expect(cy.received.some((e) => e.data.session_id === x.sessionId)).toBe(false);
    await closeWs(cx.ws);
    await closeWs(cy.ws);
  });

  it('forces logout end-to-end when an admin removes a role (DELETE role member)', async () => {
    const admin = await seedAuthedPlayer(h.db, h.redis, 76561198000010004n, roleId);
    const target = await seedAuthedPlayer(h.db, h.redis, 76561198000010005n, roleId);
    const { ws, received } = await connectWs(h.port, target.token);

    const res = await h.app.inject({
      method: 'DELETE',
      url: `/api/v1/roles/${roleId}/members/${target.playerId}`,
      cookies: { [SESSION_COOKIE]: admin.token },
    });
    expect(res.statusCode).toBe(200);

    await waitFor(() => received.some((e) => e.data.session_id === target.sessionId));
    const event = received.find((e) => e.data.session_id === target.sessionId);
    expect(event?.data.player_id).toBe(target.playerId);
    await closeWs(ws);
  });
});
