import { players, roles, servers } from '@squad/db/schema';
import { eq } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { invalidateAllPermissionCaches } from '../../src/lib/rbac.js';
import { createSession } from '../../src/lib/sessions.js';
import { testSteamId } from '../helpers/snapshot-restore.js';
import {
  assertAuditRow,
  buildIntegrationApp,
  type IntegrationHarness,
  loginAsOwner,
  makeFakeBridge,
} from './harness.js';

/**
 * DISCORD-6 (#153): the operator-facing half of the status channel — the route
 * that stores `servers.status_channel_id`. The worker half lives in
 * `apps/workers/discord/test/status-channel.test.ts`.
 */
const describeIfDb = process.env.DATABASE_URL ? describe : describe.skip;

const OWNER_STEAM = testSteamId(992001);
const PLAIN_STEAM = testSteamId(992002);
const CHANNEL_ID = '600000000000000101';

let h: IntegrationHarness;
let serverId: string;
let plainCookie: string;

describeIfDb('PUT /api/v1/integrations/discord/servers/:serverId/status-channel', () => {
  beforeAll(async () => {
    h = await buildIntegrationApp({
      seedOwner: { steamId64: OWNER_STEAM },
      bridge: makeFakeBridge(),
    });

    const plainRoleId = uuidv7();
    await h.db
      .insert(roles)
      .values({ id: plainRoleId, name: 'status-channel-plain', color: 'sky', panelAccess: true });
    const [plain] = await h.db
      .insert(players)
      .values({
        steamId64: PLAIN_STEAM,
        canonicalName: 'StatusChannelPlain',
        canonicalNameNormalized: 'statuschannelplain',
        roleId: plainRoleId,
      })
      .returning({ id: players.id });
    invalidateAllPermissionCaches();
    const { token } = await createSession(h.db, h.redis, {
      playerId: plain?.id as string,
      ip: null,
      userAgent: 'status-channel-test',
      ttlMs: 21_600_000,
    });
    plainCookie = `__Host-sid=${token}`;
  }, 60_000);

  afterAll(async () => {
    invalidateAllPermissionCaches();
    await h.cleanup();
  }, 60_000);

  beforeEach(async () => {
    // Idempotent setup: drop this suite's own server row up front as well as
    // relying on the isolated schema, so a re-run never inherits a stale
    // status_channel_id from a previous test in this file.
    if (serverId) await h.db.delete(servers).where(eq(servers.id, serverId));
    serverId = uuidv7();
    await h.db.insert(servers).values({
      id: serverId,
      displayName: 'Status Channel Test',
      slug: `status-channel-${serverId}`,
    });
  });

  it('stores the channel id on the server row', async () => {
    const res = await h.app.inject({
      method: 'PUT',
      url: `/api/v1/integrations/discord/servers/${serverId}/status-channel`,
      headers: { cookie: await loginAsOwner(h) },
      payload: { channel_id: CHANNEL_ID },
    });

    expect(res.statusCode).toBe(200);
    const [row] = await h.db
      .select({ statusChannelId: servers.statusChannelId })
      .from(servers)
      .where(eq(servers.id, serverId));
    expect(row?.statusChannelId).toBe(CHANNEL_ID);
  });

  it('clears the channel id when given null', async () => {
    const cookie = await loginAsOwner(h);
    await h.app.inject({
      method: 'PUT',
      url: `/api/v1/integrations/discord/servers/${serverId}/status-channel`,
      headers: { cookie },
      payload: { channel_id: CHANNEL_ID },
    });

    const res = await h.app.inject({
      method: 'PUT',
      url: `/api/v1/integrations/discord/servers/${serverId}/status-channel`,
      headers: { cookie },
      payload: { channel_id: null },
    });

    expect(res.statusCode).toBe(200);
    const [row] = await h.db
      .select({ statusChannelId: servers.statusChannelId })
      .from(servers)
      .where(eq(servers.id, serverId));
    expect(row?.statusChannelId).toBeNull();
  });

  it('writes a discord.status_channel.set audit row targeting the server', async () => {
    await h.app.inject({
      method: 'PUT',
      url: `/api/v1/integrations/discord/servers/${serverId}/status-channel`,
      headers: { cookie: await loginAsOwner(h) },
      payload: { channel_id: CHANNEL_ID },
    });

    await assertAuditRow(h, {
      action: 'discord.status_channel.set',
      resource: 'server',
      targetId: serverId,
    });
  });

  it('rejects a channel id that is not a Discord snowflake', async () => {
    const res = await h.app.inject({
      method: 'PUT',
      url: `/api/v1/integrations/discord/servers/${serverId}/status-channel`,
      headers: { cookie: await loginAsOwner(h) },
      payload: { channel_id: 'not-a-snowflake' },
    });

    expect(res.statusCode).toBe(400);
  });

  it('answers 404 for an unknown server', async () => {
    const res = await h.app.inject({
      method: 'PUT',
      url: `/api/v1/integrations/discord/servers/${uuidv7()}/status-channel`,
      headers: { cookie: await loginAsOwner(h) },
      payload: { channel_id: CHANNEL_ID },
    });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'server_not_found' });
  });

  it('requires integration:manage — 401 anonymous, 403 without the permission', async () => {
    const endpoints = [
      { method: 'GET' as const, url: '/api/v1/integrations/discord/status-channels' },
      {
        method: 'PUT' as const,
        url: `/api/v1/integrations/discord/servers/${serverId}/status-channel`,
      },
    ];
    for (const ep of endpoints) {
      const anon = await h.app.inject({ ...ep, payload: { channel_id: CHANNEL_ID } });
      expect(anon.statusCode, `${ep.method} ${ep.url} anonymous`).toBe(401);

      const plain = await h.app.inject({
        ...ep,
        headers: { cookie: plainCookie },
        payload: { channel_id: CHANNEL_ID },
      });
      expect(plain.statusCode, `${ep.method} ${ep.url} without permission`).toBe(403);
    }
  });

  it('lists servers with their configured status channel', async () => {
    const cookie = await loginAsOwner(h);
    await h.app.inject({
      method: 'PUT',
      url: `/api/v1/integrations/discord/servers/${serverId}/status-channel`,
      headers: { cookie },
      payload: { channel_id: CHANNEL_ID },
    });

    const res = await h.app.inject({
      method: 'GET',
      url: '/api/v1/integrations/discord/status-channels',
      headers: { cookie },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as { items: Array<{ server_id: string; channel_id: string | null }> };
    const mine = body.items.find((i) => i.server_id === serverId);
    expect(mine?.channel_id).toBe(CHANNEL_ID);
  });
});
