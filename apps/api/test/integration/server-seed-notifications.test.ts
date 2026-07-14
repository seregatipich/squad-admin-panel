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
import { invalidatePermissionCache } from '../../src/lib/rbac.js';
import { testSteamId } from '../helpers/snapshot-restore.js';
import { buildIntegrationApp, type IntegrationHarness, loginAsOwner } from './harness.js';

const OWNER_STEAM_ID = testSteamId(143000);
const SERVER_ID = '019f4700-0000-7000-8000-000000000001';
const MANUAL_RULE_ID = '00000000-0000-7000-8000-000000000077';

let h: IntegrationHarness;

beforeEach(async () => {
  h = await buildIntegrationApp({ seedOwner: { steamId64: OWNER_STEAM_ID } });
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
      name: `SeedNotify-${keys.join('-') || 'none'}-${roleId.slice(0, 8)}`,
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

  it('accepts manageserver, publishes a durable event, alerts subscriptions, and rate-limits repeats', async () => {
    const cookie = await asRoleWithSquadPermissions(['manageserver']);

    const subscription = await h.app.inject({
      method: 'PUT',
      url: `/api/v1/servers/${SERVER_ID}/seed-subscription`,
      headers: { cookie },
      payload: { channel: 'webpush', enabled: true },
    });
    expect(subscription.statusCode).toBe(200);

    const call = await h.app.inject({
      method: 'POST',
      url: `/api/v1/servers/${SERVER_ID}/seed-call`,
      headers: { cookie },
    });
    expect(call.statusCode).toBe(200);
    expect(call.json()).toMatchObject({
      ok: true,
      join_link: 'steam://connect/test-host:7787',
      notified: 1,
    });

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
      event_kind: 'seed.call_sent',
      channel: 'webpush',
    });

    const repeated = await h.app.inject({
      method: 'POST',
      url: `/api/v1/servers/${SERVER_ID}/seed-call`,
      headers: { cookie },
    });
    expect(repeated.statusCode).toBe(429);
    expect(repeated.headers['retry-after']).toBeDefined();
    expect(repeated.json()).toMatchObject({ error: 'seed_call_rate_limited' });

    const audit = await h.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.actionType, 'seed.call_sent'), eq(auditLog.targetId, SERVER_ID)));
    expect(audit).toHaveLength(1);
  });

  it('unsubscribing stops AUTO-3 alert materialization', async () => {
    const cookie = await loginAsOwner(h);
    const subscribe = await h.app.inject({
      method: 'PUT',
      url: `/api/v1/servers/${SERVER_ID}/seed-subscription`,
      headers: { cookie },
      payload: { channel: 'email', enabled: true },
    });
    expect(subscribe.statusCode).toBe(200);
    const unsubscribe = await h.app.inject({
      method: 'PUT',
      url: `/api/v1/servers/${SERVER_ID}/seed-subscription`,
      headers: { cookie },
      payload: { channel: 'email', enabled: false },
    });
    expect(unsubscribe.statusCode).toBe(200);

    await h.redis.del(`seed:call:cooldown:${SERVER_ID}`);
    const call = await h.app.inject({
      method: 'POST',
      url: `/api/v1/servers/${SERVER_ID}/seed-call`,
      headers: { cookie },
    });
    expect(call.statusCode).toBe(200);
    expect(call.json().notified).toBe(0);

    const subscriptions = await h.app.inject({
      method: 'GET',
      url: '/api/v1/seed-subscriptions',
      headers: { cookie },
    });
    expect(subscriptions.statusCode).toBe(200);
    expect(subscriptions.json()).toEqual({ subscriptions: [] });
  });
});
