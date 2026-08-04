import {
  alertEvents,
  auditLog,
  events,
  players,
  roleSquadPermissions,
  roles,
  serverSettings,
  servers,
} from '@squad/db/schema';
import { and, eq } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { invalidatePermissionCache } from '../../src/lib/rbac.js';
import { createSession } from '../../src/lib/sessions.js';
import type { LiveEvent } from '../../src/plugins/live-bus.js';
import { testSteamId } from '../helpers/snapshot-restore.js';
import { buildIntegrationApp, type IntegrationHarness, loginAsOwner } from './harness.js';

const OWNER_STEAM_ID = testSteamId(143000);
const SUBSCRIBER_STEAM_ID = testSteamId(143001);
const SERVER_ID = '019f4700-0000-7000-8000-000000000001';
const MANUAL_RULE_ID = '00000000-0000-7000-8000-000000000077';

type AlertTriggeredEvent = Extract<LiveEvent, { type: 'alert.triggered' }>;

let h: IntegrationHarness;

beforeEach(async () => {
  h = await buildIntegrationApp({ seedOwner: { steamId64: OWNER_STEAM_ID }, seedOwnerGuard: true });
  await h.db.insert(servers).values({
    id: SERVER_ID,
    displayName: 'Seed Notification Server',
    slug: 'seed-notification-server',
  });
  await h.db.insert(serverSettings).values({
    serverId: SERVER_ID,
    installPath: '/srv/squad',
    gamePort: 7787,
    queryPort: 27165,
    beaconPort: 15000,
    rconPort: 21114,
  });
});

afterEach(async () => {
  if (h.seed.ownerPlayerId) invalidatePermissionCache(h.seed.ownerPlayerId);
  await h.cleanup();
});

async function asRoleWithSquadPermissions(keys: string[]): Promise<string> {
  const roleId = uuidv7();
  await h.db.transaction(async (tx) => {
    await tx.insert(roles).values({
      id: roleId,
      name: `SeedNotify-${keys.join('-') || 'none'}-${roleId}`,
      color: 'blue',
      isSystemRole: false,
      panelAccess: true,
    });
    for (const key of keys) {
      await tx.insert(roleSquadPermissions).values({ roleId, squadPermissionKey: key });
    }
  });
  await h.db
    .update(players)
    .set({ roleId })
    // biome-ignore lint/style/noNonNullAssertion: owner is seeded in beforeEach
    .where(eq(players.steamId64, h.seed.ownerSteamId64!));
  // biome-ignore lint/style/noNonNullAssertion: owner is seeded in beforeEach
  invalidatePermissionCache(h.seed.ownerPlayerId!);
  return loginAsOwner(h);
}

async function createSubscriber(): Promise<{ cookie: string; playerId: string }> {
  const roleId = uuidv7();
  await h.db.insert(roles).values({
    id: roleId,
    name: `SeedSubscriber-${roleId}`,
    color: 'blue',
    isSystemRole: false,
    panelAccess: true,
  });
  const [player] = await h.db
    .insert(players)
    .values({
      steamId64: SUBSCRIBER_STEAM_ID,
      canonicalName: 'Seed Subscriber',
      canonicalNameNormalized: 'seed subscriber',
      roleId,
    })
    .returning({ id: players.id });
  if (!player) throw new Error('subscriber insert failed');
  const { token } = await createSession(h.db, h.redis, {
    playerId: player.id,
    ip: null,
    userAgent: 'seed-notification-test',
    ttlMs: 21_600_000,
  });
  return { cookie: `__Host-sid=${token}`, playerId: player.id };
}

async function connectAlerts(
  cookie: string,
): Promise<{ socket: WebSocket; received: AlertTriggeredEvent[] }> {
  if (!h.app.server.listening) {
    await h.app.listen({ port: 0, host: '127.0.0.1' });
  }
  const address = h.app.server.address();
  if (!address || typeof address === 'string') throw new Error('integration app has no TCP port');

  const socket = new WebSocket(`ws://127.0.0.1:${address.port}/api/v1/ws/live`, {
    headers: { cookie },
  });
  const received: AlertTriggeredEvent[] = [];
  socket.on('message', (raw) => {
    const event = JSON.parse(raw.toString()) as LiveEvent;
    if (event.type === 'alert.triggered') received.push(event);
  });
  await new Promise<void>((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });
  return { socket, received };
}

async function closeSocket(socket: WebSocket): Promise<void> {
  if (socket.readyState === WebSocket.CLOSED) return;
  socket.close();
  await new Promise<void>((resolve) => socket.once('close', () => resolve()));
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('waitFor timeout');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe('SEED-4 seed-call notifications', () => {
  it('requires authentication and chat/manageserver permission', async () => {
    const unauthenticated = await h.app.inject({
      method: 'POST',
      url: `/api/v1/servers/${SERVER_ID}/seed-call`,
    });
    expect(unauthenticated.statusCode).toBe(401);

    const cookie = await asRoleWithSquadPermissions([]);
    const forbidden = await h.app.inject({
      method: 'POST',
      url: `/api/v1/servers/${SERVER_ID}/seed-call`,
      headers: { cookie },
    });
    expect(forbidden.statusCode).toBe(403);
  });

  it('delivers only to the subscriber with a join link, enforces cooldown, stops after unsubscribe, and audits the actor', async () => {
    const actorCookie = await asRoleWithSquadPermissions(['manageserver']);
    const subscriber = await createSubscriber();

    const subscription = await h.app.inject({
      method: 'PUT',
      url: `/api/v1/servers/${SERVER_ID}/seed-subscription`,
      headers: { cookie: subscriber.cookie },
      payload: { channel: 'webpush', enabled: true },
    });
    expect(subscription.statusCode).toBe(200);

    const subscriberSocket = await connectAlerts(subscriber.cookie);
    const actorSocket = await connectAlerts(actorCookie);
    try {
      const call = await h.app.inject({
        method: 'POST',
        url: `/api/v1/servers/${SERVER_ID}/seed-call`,
        headers: { cookie: actorCookie },
      });
      expect(call.statusCode).toBe(200);
      expect(call.json()).toMatchObject({
        ok: true,
        join_link: 'steam://connect/test-host:7787',
        notified: 1,
      });

      await waitFor(() => subscriberSocket.received.length === 1);
      expect(subscriberSocket.received[0]?.data).toMatchObject({
        player_id: subscriber.playerId,
        event_kind: 'seed.call_sent',
        channel: 'webpush',
        message: 'Нужен сид',
        server_name: 'Seed Notification Server',
        join_link: 'steam://connect/test-host:7787',
      });
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(actorSocket.received).toHaveLength(0);

      const storedEvents = await h.db
        .select()
        .from(events)
        .where(and(eq(events.serverId, SERVER_ID), eq(events.kind, 'seed.call_sent')));
      expect(storedEvents).toHaveLength(1);
      expect(storedEvents[0]?.payload).toMatchObject({
        server_name: 'Seed Notification Server',
        source: 'manual',
        join_link: 'steam://connect/test-host:7787',
      });

      const storedAlerts = await h.db
        .select()
        .from(alertEvents)
        .where(eq(alertEvents.ruleId, MANUAL_RULE_ID));
      expect(storedAlerts).toHaveLength(1);
      expect(storedAlerts[0]?.payload).toMatchObject({
        player_id: subscriber.playerId,
        event_kind: 'seed.call_sent',
        channel: 'webpush',
        join_link: 'steam://connect/test-host:7787',
      });

      const repeated = await h.app.inject({
        method: 'POST',
        url: `/api/v1/servers/${SERVER_ID}/seed-call`,
        headers: { cookie: actorCookie },
      });
      expect(repeated.statusCode).toBe(429);
      expect(Number(repeated.headers['retry-after'])).toBeGreaterThan(0);
      expect(Number(repeated.headers['retry-after'])).toBeLessThanOrEqual(2 * 60 * 60);
      expect(repeated.json()).toMatchObject({ error: 'seed_call_rate_limited' });

      const unsubscribe = await h.app.inject({
        method: 'PUT',
        url: `/api/v1/servers/${SERVER_ID}/seed-subscription`,
        headers: { cookie: subscriber.cookie },
        payload: { channel: 'webpush', enabled: false },
      });
      expect(unsubscribe.statusCode).toBe(200);

      await h.redis.del(`seed:call:cooldown:${SERVER_ID}`);
      const callAfterUnsubscribe = await h.app.inject({
        method: 'POST',
        url: `/api/v1/servers/${SERVER_ID}/seed-call`,
        headers: { cookie: actorCookie },
      });
      expect(callAfterUnsubscribe.statusCode).toBe(200);
      expect(callAfterUnsubscribe.json().notified).toBe(0);
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(subscriberSocket.received).toHaveLength(1);

      const subscriptions = await h.app.inject({
        method: 'GET',
        url: '/api/v1/seed-subscriptions',
        headers: { cookie: subscriber.cookie },
      });
      expect(subscriptions.statusCode).toBe(200);
      expect(subscriptions.json()).toEqual({ subscriptions: [] });

      const audit = await h.db
        .select()
        .from(auditLog)
        .where(and(eq(auditLog.actionType, 'seed.call_sent'), eq(auditLog.targetId, SERVER_ID)));
      expect(audit).toHaveLength(2);
      expect(audit.every((entry) => entry.actorPlayerId === h.seed.ownerPlayerId)).toBe(true);
    } finally {
      await Promise.all([closeSocket(subscriberSocket.socket), closeSocket(actorSocket.socket)]);
    }
  });
});
