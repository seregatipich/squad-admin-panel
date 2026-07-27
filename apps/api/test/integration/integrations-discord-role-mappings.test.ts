import { discordRoleMappings, players, roles } from '@squad/db/schema';
import {
  DISCORD_ROLE_SYNC_STATUS_KEY,
  DISCORD_ROLE_SYNC_STREAM,
  STREAM_NAME,
} from '@squad/shared-types';
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

const OWNER_STEAM = testSteamId(990001);
const PLAIN_STEAM = testSteamId(990002);
const TARGET_STEAM = testSteamId(990003);

const DISCORD_ROLE_VIP = '700000000000000001';
const DISCORD_ROLE_MOD = '700000000000000002';

const describeIfDb = process.env.DATABASE_URL ? describe : describe.skip;

let h: IntegrationHarness;
let vipRoleId: string;
let moderatorRoleId: string;
let targetPlayerId: string;

async function login(playerId: string): Promise<string> {
  invalidateAllPermissionCaches();
  const { token } = await createSession(h.db, h.redis, {
    playerId,
    ip: null,
    userAgent: 'discord-role-mappings-test',
    ttlMs: 21_600_000,
  });
  return `__Host-sid=${token}`;
}

async function createMapping(
  cookie: string,
  body: Record<string, unknown>,
): Promise<{ statusCode: number; json: Record<string, unknown> }> {
  const res = await h.app.inject({
    method: 'POST',
    url: '/api/v1/integrations/discord/role-mappings',
    headers: { cookie },
    payload: body,
  });
  return { statusCode: res.statusCode, json: res.json() };
}

beforeAll(async () => {
  h = await buildIntegrationApp({
    seedOwner: { steamId64: OWNER_STEAM },
    bridge: makeFakeBridge(),
  });

  vipRoleId = uuidv7();
  moderatorRoleId = uuidv7();
  await h.db.insert(roles).values([
    { id: vipRoleId, name: 'rolesync-vip', color: 'sky', panelAccess: false },
    { id: moderatorRoleId, name: 'rolesync-mod', color: 'amber', panelAccess: false },
  ]);

  const plainRoleId = uuidv7();
  await h.db
    .insert(roles)
    .values({ id: plainRoleId, name: 'rolesync-plain', color: 'neutral', panelAccess: true });
  await h.db.insert(players).values({
    steamId64: PLAIN_STEAM,
    canonicalName: 'RoleSyncPlain',
    canonicalNameNormalized: 'rolesyncplain',
    roleId: plainRoleId,
  });

  const [target] = await h.db
    .insert(players)
    .values({
      steamId64: TARGET_STEAM,
      canonicalName: 'RoleSyncTarget',
      canonicalNameNormalized: 'rolesynctarget',
    })
    .returning({ id: players.id });
  targetPlayerId = target.id;
  invalidateAllPermissionCaches();
}, 60_000);

afterAll(async () => {
  invalidateAllPermissionCaches();
  await h.cleanup();
}, 60_000);

beforeEach(async () => {
  await h.db.delete(discordRoleMappings);
  await h.redis.del(DISCORD_ROLE_SYNC_STATUS_KEY);
  await h.redis.del(DISCORD_ROLE_SYNC_STREAM);
});

describeIfDb('Discord role mappings — RBAC gating', () => {
  const endpoints: Array<{ method: 'GET' | 'POST' | 'PATCH' | 'DELETE'; url: string }> = [
    { method: 'GET', url: '/api/v1/integrations/discord/role-mappings' },
    { method: 'POST', url: '/api/v1/integrations/discord/role-mappings' },
    {
      method: 'PATCH',
      url: '/api/v1/integrations/discord/role-mappings/00000000-0000-0000-0000-0000000000ab',
    },
    {
      method: 'DELETE',
      url: '/api/v1/integrations/discord/role-mappings/00000000-0000-0000-0000-0000000000ab',
    },
    { method: 'POST', url: '/api/v1/integrations/discord/role-mappings/reconcile' },
  ];

  it('answers 401 on every endpoint without a session', async () => {
    for (const ep of endpoints) {
      const res = await h.app.inject({ method: ep.method, url: ep.url, payload: '{}' });
      expect(res.statusCode, `${ep.method} ${ep.url}`).toBe(401);
    }
  });

  it('answers 403 on every endpoint for a panel user without integration:manage', async () => {
    const [row] = await h.db
      .select({ id: players.id })
      .from(players)
      .where(eq(players.steamId64, PLAIN_STEAM))
      .limit(1);
    const cookie = await login(row.id);
    for (const ep of endpoints) {
      const res = await h.app.inject({
        method: ep.method,
        url: ep.url,
        headers: { cookie },
        payload: '{}',
      });
      expect(res.statusCode, `${ep.method} ${ep.url}`).toBe(403);
    }
  });
});

describeIfDb('Discord role mappings — CRUD', () => {
  it('creates a mapping, persists it and writes an audit row', async () => {
    const cookie = await loginAsOwner(h);
    const created = await createMapping(cookie, {
      role_id: vipRoleId,
      discord_role_id: DISCORD_ROLE_VIP,
    });

    expect(created.statusCode).toBe(201);
    expect(created.json).toMatchObject({
      role_id: vipRoleId,
      role_name: 'rolesync-vip',
      discord_role_id: DISCORD_ROLE_VIP,
      enabled: true,
      source: 'panel_role',
    });

    const rows = await h.db
      .select()
      .from(discordRoleMappings)
      .where(eq(discordRoleMappings.roleId, vipRoleId));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.discordRoleId).toBe(DISCORD_ROLE_VIP);

    await assertAuditRow(h, {
      action: 'discord.role_mapping.create',
      resource: 'discord_role_mapping',
    });
  });

  it('rejects a second mapping for the same panel role with 409 role_mapping_exists', async () => {
    const cookie = await loginAsOwner(h);
    await createMapping(cookie, { role_id: vipRoleId, discord_role_id: DISCORD_ROLE_VIP });
    const duplicate = await createMapping(cookie, {
      role_id: vipRoleId,
      discord_role_id: DISCORD_ROLE_MOD,
    });

    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json).toEqual({ error: 'role_mapping_exists' });
  });

  it('rejects an unknown panel role with 404 role_not_found', async () => {
    const cookie = await loginAsOwner(h);
    const res = await createMapping(cookie, {
      role_id: '00000000-0000-0000-0000-0000000000ff',
      discord_role_id: DISCORD_ROLE_VIP,
    });

    expect(res.statusCode).toBe(404);
    expect(res.json).toEqual({ error: 'role_not_found' });
  });

  it('rejects a non-snowflake discord role id with 400', async () => {
    const cookie = await loginAsOwner(h);
    const res = await createMapping(cookie, {
      role_id: vipRoleId,
      discord_role_id: 'not-a-snowflake',
    });

    expect(res.statusCode).toBe(400);
  });

  it('lists mappings with the panel role name joined in', async () => {
    const cookie = await loginAsOwner(h);
    await createMapping(cookie, { role_id: vipRoleId, discord_role_id: DISCORD_ROLE_VIP });
    await createMapping(cookie, { role_id: moderatorRoleId, discord_role_id: DISCORD_ROLE_MOD });

    const res = await h.app.inject({
      method: 'GET',
      url: '/api/v1/integrations/discord/role-mappings',
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { items: Array<Record<string, unknown>>; status: unknown };
    expect(body.items).toHaveLength(2);
    expect(body.items.map((i) => i.role_name).sort()).toEqual(['rolesync-mod', 'rolesync-vip']);
    expect(body.status).toBeNull();
  });

  it('updates discord_role_id and enabled, and writes an update audit row', async () => {
    const cookie = await loginAsOwner(h);
    const created = await createMapping(cookie, {
      role_id: vipRoleId,
      discord_role_id: DISCORD_ROLE_VIP,
    });
    const id = created.json.id as string;

    const res = await h.app.inject({
      method: 'PATCH',
      url: `/api/v1/integrations/discord/role-mappings/${id}`,
      headers: { cookie },
      payload: { discord_role_id: DISCORD_ROLE_MOD, enabled: false },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      id,
      discord_role_id: DISCORD_ROLE_MOD,
      enabled: false,
    });
    await assertAuditRow(h, {
      action: 'discord.role_mapping.update',
      resource: 'discord_role_mapping',
      targetId: id,
    });
  });

  it('answers 404 mapping_not_found when patching an unknown id', async () => {
    const cookie = await loginAsOwner(h);
    const res = await h.app.inject({
      method: 'PATCH',
      url: '/api/v1/integrations/discord/role-mappings/00000000-0000-0000-0000-0000000000ab',
      headers: { cookie },
      payload: { enabled: false },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'mapping_not_found' });
  });

  it('deletes a mapping and writes a delete audit row', async () => {
    const cookie = await loginAsOwner(h);
    const created = await createMapping(cookie, {
      role_id: vipRoleId,
      discord_role_id: DISCORD_ROLE_VIP,
    });
    const id = created.json.id as string;

    const res = await h.app.inject({
      method: 'DELETE',
      url: `/api/v1/integrations/discord/role-mappings/${id}`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    expect(
      await h.db.select().from(discordRoleMappings).where(eq(discordRoleMappings.id, id)),
    ).toHaveLength(0);
    await assertAuditRow(h, {
      action: 'discord.role_mapping.delete',
      resource: 'discord_role_mapping',
      targetId: id,
    });
  });

  it('answers 404 mapping_not_found when deleting an unknown id', async () => {
    const cookie = await loginAsOwner(h);
    const res = await h.app.inject({
      method: 'DELETE',
      url: '/api/v1/integrations/discord/role-mappings/00000000-0000-0000-0000-0000000000ab',
      headers: { cookie },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'mapping_not_found' });
  });
});

describeIfDb('Discord role mappings — worker status surface', () => {
  it('surfaces the worker error state so the UI cannot miss a silent failure', async () => {
    const cookie = await loginAsOwner(h);
    await h.redis.set(
      DISCORD_ROLE_SYNC_STATUS_KEY,
      JSON.stringify({
        state: 'error',
        reason: 'missing_permissions',
        message: 'У бота нет права Manage Roles в Discord-гильдии.',
        checked_at: '2026-07-27T10:00:00.000Z',
      }),
    );

    const res = await h.app.inject({
      method: 'GET',
      url: '/api/v1/integrations/discord/role-mappings',
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { status: unknown }).status).toEqual({
      state: 'error',
      reason: 'missing_permissions',
      message: 'У бота нет права Manage Roles в Discord-гильдии.',
      checked_at: '2026-07-27T10:00:00.000Z',
    });
  });

  it('reports a null status when the worker has never written one', async () => {
    const cookie = await loginAsOwner(h);
    const res = await h.app.inject({
      method: 'GET',
      url: '/api/v1/integrations/discord/role-mappings',
      headers: { cookie },
    });
    expect((res.json() as { status: unknown }).status).toBeNull();
  });
});

describeIfDb('Discord role sync — stream publication', () => {
  it('enqueues a full reconcile request on demand', async () => {
    const cookie = await loginAsOwner(h);
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/v1/integrations/discord/role-mappings/reconcile',
      headers: { cookie },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ enqueued: true });

    const entries = await h.redis.xrange(DISCORD_ROLE_SYNC_STREAM, '-', '+');
    expect(entries).toHaveLength(1);
    const fields = entries[0]?.[1] ?? [];
    const payload = JSON.parse(fields[fields.indexOf('payload') + 1] ?? '{}');
    expect(payload).toMatchObject({ player_id: null, reason: 'manual_reconcile' });
  });

  it('publishes a per-player sync request when a panel role is assigned', async () => {
    const cookie = await loginAsOwner(h);
    const res = await h.app.inject({
      method: 'PUT',
      url: `/api/v1/players/${targetPlayerId}/role`,
      headers: { cookie },
      payload: { role_id: vipRoleId },
    });
    expect(res.statusCode).toBe(200);

    const entries = await h.redis.xrange(DISCORD_ROLE_SYNC_STREAM, '-', '+');
    expect(entries).toHaveLength(1);
    const fields = entries[0]?.[1] ?? [];
    const payload = JSON.parse(fields[fields.indexOf('payload') + 1] ?? '{}');
    expect(payload).toMatchObject({ player_id: targetPlayerId, reason: 'player.role.assign' });
  });

  it('publishes a per-player sync request when a panel role is removed', async () => {
    const cookie = await loginAsOwner(h);
    await h.app.inject({
      method: 'PUT',
      url: `/api/v1/players/${targetPlayerId}/role`,
      headers: { cookie },
      payload: { role_id: moderatorRoleId },
    });
    await h.redis.del(DISCORD_ROLE_SYNC_STREAM);

    const res = await h.app.inject({
      method: 'DELETE',
      url: `/api/v1/players/${targetPlayerId}/role`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);

    const entries = await h.redis.xrange(DISCORD_ROLE_SYNC_STREAM, '-', '+');
    expect(entries).toHaveLength(1);
    const fields = entries[0]?.[1] ?? [];
    const payload = JSON.parse(fields[fields.indexOf('payload') + 1] ?? '{}');
    expect(payload).toMatchObject({ player_id: targetPlayerId, reason: 'player.role.unassign' });
  });

  it('keeps the role-sync stream separate from the shared events stream', async () => {
    expect(DISCORD_ROLE_SYNC_STREAM).toBe('discord:role-sync');
    expect(DISCORD_ROLE_SYNC_STREAM).not.toBe(STREAM_NAME.eventsGlobal());
  });
});
