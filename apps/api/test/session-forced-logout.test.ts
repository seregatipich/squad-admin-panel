import cookie from '@fastify/cookie';
import websocket from '@fastify/websocket';
import type { BridgeClient } from '@squad/bridge-client';
import * as schema from '@squad/db/schema';
import {
  playerApiTokens,
  players,
  rolePermissions,
  roles,
  sessions as sessionsTable,
} from '@squad/db/schema';
import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import Redis from 'ioredis';
import postgres from 'postgres';
import { v7 as uuidv7 } from 'uuid';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { mintApiToken } from '../src/lib/api-tokens.js';
import diagPlugin from '../src/lib/diag.js';
import { invalidatePermissionCache } from '../src/lib/rbac.js';
import { createSession, revokeAllForPlayer, revokeSession } from '../src/lib/sessions.js';
import authPlugin, { SESSION_COOKIE } from '../src/plugins/auth.js';
import liveBusPlugin, { type LiveEvent } from '../src/plugins/live-bus.js';
import authRoutes from '../src/routes/auth.js';
import liveRoutes from '../src/routes/live.js';
import roleMembersRoutes from '../src/routes/role-members.js';
import { testSteamId } from './helpers/snapshot-restore.js';
import { createIsolatedSchema, makeFakeBridge, runMigrations } from './integration/harness.js';

const TEST_REDIS_URL = process.env.TEST_REDIS_URL ?? 'redis://127.0.0.1:6379/15';

async function buildApp(opts: { dbUrl: string; revalidateIntervalMs?: number }) {
  const app = Fastify({ logger: false });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  const sql = postgres(opts.dbUrl, { max: 4, onnotice: () => undefined });
  // biome-ignore lint/suspicious/noExplicitAny: integration test
  const db = drizzle(sql, { schema }) as any;
  const redis = new Redis(TEST_REDIS_URL);
  app.decorate('db', db);
  app.decorate('redis', redis);
  app.decorate('bridge', makeFakeBridge() as unknown as BridgeClient);
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
  await app.register(liveRoutes, { revalidateIntervalMs: opts.revalidateIntervalMs });
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
  // A socket the server already closed (the #12 revocation paths) has emitted
  // its 'close' event; waiting for another one would hang.
  if (ws.readyState === WebSocket.CLOSED) return;
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

interface ObservedSocket {
  ws: WebSocket;
  frames: LiveEvent[];
  closeCode: () => number | null;
}

/**
 * Opens `/api/v1/ws/live` like a modified client would: it never reacts to
 * `session.revoked` and never closes on its own, so any close observed here
 * was initiated by the server.
 */
async function connectIgnoringRevocation(
  port: number,
  auth: { cookieToken: string } | { bearer: string },
): Promise<ObservedSocket> {
  const headers =
    'cookieToken' in auth
      ? { cookie: `${SESSION_COOKIE}=${auth.cookieToken}` }
      : { authorization: `Bearer ${auth.bearer}` };
  const ws = new WebSocket(`ws://127.0.0.1:${port}/api/v1/ws/live`, { headers });
  const frames: LiveEvent[] = [];
  let code: number | null = null;
  ws.on('message', (raw) => frames.push(JSON.parse(raw.toString()) as LiveEvent));
  ws.on('close', (closeCode) => {
    code = closeCode;
  });
  await new Promise<void>((resolve, reject) => {
    ws.on('open', () => resolve());
    ws.on('error', (err) => reject(err));
  });
  return { ws, frames, closeCode: () => code };
}

/** A non-system panel role, so demoting its member never trips the last-Owner guard. */
async function createPanelRole(
  // biome-ignore lint/suspicious/noExplicitAny: drizzle test handle
  db: any,
): Promise<string> {
  const id = uuidv7();
  await db.insert(roles).values({
    id,
    name: `ws-revocation-${id}`,
    panelAccess: true,
    combatView: true,
  });
  return id;
}

function combatEvent(): LiveEvent {
  const now = new Date().toISOString();
  return {
    type: 'combat.event',
    ts: now,
    data: {
      server_id: '00000000-0000-0000-0000-00000000c0de',
      match_id: null,
      kind: 'combat_death',
      attacker_player_id: 'attacker-1',
      victim_player_id: 'victim-1',
      weapon: 'BP_AK74',
      damage: 100,
      is_teamkill: false,
      is_suicide: false,
      occurred_at: now,
    },
  };
}

/** A frame every socket receives, used to prove earlier frames were filtered. */
function deliveryMarker(serverId: string): LiveEvent {
  return {
    type: 'rcon.status',
    ts: new Date().toISOString(),
    data: { server_id: serverId, state: 'connected' },
  };
}

describe('server-side close of live sockets on revocation (#12)', () => {
  describe('event-driven close (default revalidation interval)', () => {
    let schemaInfo: Awaited<ReturnType<typeof createIsolatedSchema>>;
    let h: Awaited<ReturnType<typeof buildApp>>;
    let roleId: string;

    beforeEach(async () => {
      schemaInfo = await createIsolatedSchema();
      await runMigrations(schemaInfo.url);
      // The default 30 s revalidation cannot fire inside these tests, so a
      // close observed here can only come from the session.revoked handler.
      h = await buildApp({ dbUrl: schemaInfo.url });
      roleId = await ownerRoleId(h.db);
    });
    afterEach(async () => {
      await h.cleanup();
      await schemaInfo.drop();
    });

    it('closes the socket with 4001 when its session is revoked, even if the client ignores session.revoked', async () => {
      const player = await seedAuthedPlayer(h.db, h.redis, testSteamId(12001), roleId);
      const sock = await connectIgnoringRevocation(h.port, { cookieToken: player.token });

      await revokeAllForPlayer(h.db, h.redis, player.playerId, h.app.liveBus);

      await waitFor(() => sock.closeCode() === 4001);
      // The browser still gets the event first so its forced-logout UX runs.
      expect(
        sock.frames.some(
          (f) => f.type === 'session.revoked' && f.data.session_id === player.sessionId,
        ),
      ).toBe(true);
    });

    it('closes only the socket of the revoked session, not the same player’s other session', async () => {
      const player = await seedAuthedPlayer(h.db, h.redis, testSteamId(12002), roleId);
      const second = await createSession(h.db, h.redis, {
        playerId: player.playerId,
        ip: null,
        userAgent: 'test-ua-2',
        ttlMs: 21600 * 1000,
      });
      const kept = await connectIgnoringRevocation(h.port, { cookieToken: player.token });
      const revoked = await connectIgnoringRevocation(h.port, { cookieToken: second.token });

      const res = await h.app.inject({
        method: 'DELETE',
        url: `/api/v1/me/sessions/${encodeURIComponent(second.session.id)}`,
        cookies: { [SESSION_COOKIE]: player.token },
      });
      expect(res.statusCode).toBe(200);

      await waitFor(() => revoked.closeCode() === 4001);
      await waitFor(() =>
        kept.frames.some(
          (f) => f.type === 'session.revoked' && f.data.session_id === second.session.id,
        ),
      );
      expect(kept.closeCode()).toBeNull();
      expect(kept.ws.readyState).toBe(WebSocket.OPEN);
      await closeWs(kept.ws);
    });

    it('closes the sockets of members removed by bulk-delete (panel access lost)', async () => {
      const admin = await seedAuthedPlayer(h.db, h.redis, testSteamId(12003), roleId);
      const target = await seedAuthedPlayer(h.db, h.redis, testSteamId(12004), roleId);
      const sock = await connectIgnoringRevocation(h.port, { cookieToken: target.token });

      const res = await h.app.inject({
        method: 'POST',
        url: `/api/v1/roles/${roleId}/members/bulk-delete`,
        cookies: { [SESSION_COOKIE]: admin.token },
        payload: { player_ids: [target.playerId] },
      });
      expect(res.statusCode).toBe(200);

      await waitFor(() => sock.closeCode() === 4001);
    });
  });

  describe('periodic revalidation', () => {
    let schemaInfo: Awaited<ReturnType<typeof createIsolatedSchema>>;
    let h: Awaited<ReturnType<typeof buildApp>>;
    let roleId: string;

    beforeEach(async () => {
      schemaInfo = await createIsolatedSchema();
      await runMigrations(schemaInfo.url);
      h = await buildApp({ dbUrl: schemaInfo.url, revalidateIntervalMs: 100 });
      roleId = await ownerRoleId(h.db);
    });
    afterEach(async () => {
      await h.cleanup();
      await schemaInfo.drop();
    });

    it('closes with 4001 when the session disappears without any live event', async () => {
      const player = await seedAuthedPlayer(h.db, h.redis, testSteamId(12011), roleId);
      const sock = await connectIgnoringRevocation(h.port, { cookieToken: player.token });

      await revokeSession(h.db, h.redis, player.sessionId);

      await waitFor(() => sock.closeCode() === 4001);
    });

    it('closes with 4003 when the player loses server:view while the session stays valid', async () => {
      const steamId = testSteamId(12012);
      const player = await seedAuthedPlayer(h.db, h.redis, steamId, await createPanelRole(h.db));
      const sock = await connectIgnoringRevocation(h.port, { cookieToken: player.token });

      await h.db.update(players).set({ roleId: null }).where(eq(players.steamId64, steamId));
      invalidatePermissionCache(player.playerId);

      await waitFor(() => sock.closeCode() === 4003);
      const rows = await h.db
        .select()
        .from(sessionsTable)
        .where(eq(sessionsTable.playerId, player.playerId));
      expect(rows.length).toBe(1);
    });

    it('closes with 4003 a self-service session whose role loses panel_access, despite an explicit server:view grant', async () => {
      const panelRoleId = await createPanelRole(h.db);
      const player = await seedAuthedPlayer(h.db, h.redis, testSteamId(12015), panelRoleId);
      const selfService = await createSession(h.db, h.redis, {
        playerId: player.playerId,
        ip: null,
        userAgent: 'test-ua-self-service',
        ttlMs: 21600 * 1000,
        scope: 'self_service',
      });
      // While the role still holds panel_access the self-service gate is lifted.
      const sock = await connectIgnoringRevocation(h.port, { cookieToken: selfService.token });

      await h.db
        .insert(rolePermissions)
        .values({ roleId: panelRoleId, permissionKey: 'server:view' });
      await h.db.update(roles).set({ panelAccess: false }).where(eq(roles.id, panelRoleId));
      invalidatePermissionCache(player.playerId);

      await waitFor(() => sock.closeCode() === 4003);
    });

    it('closes with 4001 an API-token socket once the token is revoked', async () => {
      const player = await seedAuthedPlayer(h.db, h.redis, testSteamId(12013), roleId);
      const minted = mintApiToken();
      await h.db.insert(playerApiTokens).values({
        id: minted.id,
        playerId: player.playerId,
        name: 'ws-revocation-test',
        tokenHash: minted.tokenHash,
        scopes: ['server:view'],
      });
      const sock = await connectIgnoringRevocation(h.port, { bearer: minted.plaintext });

      await h.db
        .update(playerApiTokens)
        .set({ revokedAt: new Date() })
        .where(eq(playerApiTokens.id, minted.id));

      await waitFor(() => sock.closeCode() === 4001);
    });

    it('stops forwarding combat events once the role loses combat_view', async () => {
      const combatRoleId = await createPanelRole(h.db);
      const player = await seedAuthedPlayer(h.db, h.redis, testSteamId(12014), combatRoleId);
      const sock = await connectIgnoringRevocation(h.port, { cookieToken: player.token });
      const combatFrames = () => sock.frames.filter((f) => f.type === 'combat.event').length;

      h.app.liveBus.publish(combatEvent());
      await waitFor(() => combatFrames() === 1);

      await h.db.update(roles).set({ combatView: false }).where(eq(roles.id, combatRoleId));
      invalidatePermissionCache(player.playerId);
      // Several revalidation ticks elapse before the next publish.
      await new Promise((r) => setTimeout(r, 500));

      h.app.liveBus.publish(combatEvent());
      h.app.liveBus.publish(deliveryMarker('ws-revocation-marker'));
      await waitFor(() =>
        sock.frames.some(
          (f) => f.type === 'rcon.status' && f.data.server_id === 'ws-revocation-marker',
        ),
      );
      expect(combatFrames()).toBe(1);
      expect(sock.closeCode()).toBeNull();
      await closeWs(sock.ws);
    });
  });
});
