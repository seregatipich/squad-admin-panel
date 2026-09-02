import { adminsCfgSyncOutbox, auditLog, players, roles, servers } from '@squad/db/schema';
import { and, desc, eq } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
// WL-3 auto-expiry reuses the existing worker-role-expirer machinery (VIPSUB-1);
// the chain is driven here from the real production tick to prove the acceptance
// criterion "an expired term automatically clears the role and syncs Admins.cfg".
import {
  clearExpiredAssignments,
  findExpiredAssignments,
  type RoleExpiryTickDeps,
  revokeAllSessionsForPlayer,
  runRoleExpiryTick,
  writeRoleExpiryAuditEntry,
} from '../../../workers/role-expirer/src/tick.js';
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

const OWNER_STEAM = testSteamId(167001);
const OUTSIDER_STEAM = testSteamId(167002);
const HAPPY_STEAM = testSteamId(167010);
const APPROVE_STEAM = testSteamId(167030);
const DEFAULT30_STEAM = testSteamId(167011);
const PERMANENT_STEAM = testSteamId(167012);
const EXPIRY_STEAM = testSteamId(167013);
const REJECT_STEAM = testSteamId(167014);
const NO_PLAYER_STEAM = testSteamId(167015);
const DUP_STEAM = testSteamId(167016);
const FALLBACK_STEAM = testSteamId(167017);
const BAD_STEAM = '123'; // not 17 digits

const describeIfDb = process.env.DATABASE_URL ? describe : describe.skip;

let h: IntegrationHarness;
let ownerCookie: string;
let outsiderCookie: string;
let vipRoleId: string;
let fallbackRoleId: string;
let happyPlayerId: string;
let approvePlayerId: string;
let default30PlayerId: string;
let permanentPlayerId: string;
let expiryPlayerId: string;
let activeServerId: string;

async function createRole(name: string, panelAccess: boolean): Promise<string> {
  const roleId = uuidv7();
  await h.db.insert(roles).values({ id: roleId, name, color: '#3366AA', panelAccess });
  return roleId;
}

async function createPlayer(steamId64: bigint, roleId: string | null = null): Promise<string> {
  const id = uuidv7();
  const stub = `Player${String(steamId64).slice(-5)}`;
  await h.db.insert(players).values({
    id,
    steamId64,
    canonicalName: stub,
    canonicalNameNormalized: stub.toLowerCase(),
    roleId,
  });
  return id;
}

async function loginAsSteam(steamId64: bigint): Promise<string> {
  const [row] = await h.db
    .select({ id: players.id })
    .from(players)
    .where(eq(players.steamId64, steamId64))
    .limit(1);
  if (!row) throw new Error(`No player for steamId64=${steamId64}`);
  invalidateAllPermissionCaches();
  const { token } = await createSession(h.db, h.redis, {
    playerId: row.id,
    ip: null,
    userAgent: 'wl3-test',
    ttlMs: 21_600_000,
  });
  return `__Host-sid=${token}`;
}

async function setSettings(enabled: boolean, defaultDays: number | null): Promise<void> {
  const res = await h.app.inject({
    method: 'PUT',
    url: '/api/v1/whitelist/applications/settings',
    headers: { cookie: ownerCookie },
    payload: { enabled, default_days: defaultDays },
  });
  if (res.statusCode !== 200) throw new Error(`setSettings failed: ${res.statusCode} ${res.body}`);
}

async function submit(steamId64: bigint, body = 'please whitelist me'): Promise<string> {
  const res = await h.app.inject({
    method: 'POST',
    url: '/api/v1/public/whitelist/applications',
    payload: { steam_id64: steamId64.toString(), body },
  });
  if (res.statusCode !== 201) throw new Error(`submit failed: ${res.statusCode} ${res.body}`);
  return res.json<{ id: string }>().id;
}

async function outboxRows(): Promise<Array<{ serverId: string; reason: string }>> {
  const rows = await h.db
    .select({ serverId: adminsCfgSyncOutbox.serverId, payload: adminsCfgSyncOutbox.payload })
    .from(adminsCfgSyncOutbox);
  return rows.map((r) => ({
    serverId: r.serverId,
    reason: (r.payload as { reason: string }).reason,
  }));
}

beforeAll(async () => {
  h = await buildIntegrationApp({
    seedOwner: { steamId64: OWNER_STEAM, canonicalName: 'Wl3Owner' },
    bridge: makeFakeBridge(),
  });
  ownerCookie = await loginAsOwner(h);

  vipRoleId = await createRole('Wl3Vip', false);
  fallbackRoleId = await createRole('Wl3Fallback', false);
  // Non-panel-access role: in this RBAC model any panel-access role is granted
  // whitelist:view/edit implicitly (rbac.ts computePermissions), so the only
  // way to lack those scopes is to have no panel access at all.
  const outsiderRoleId = await createRole('Wl3Outsider', false);
  await createPlayer(OUTSIDER_STEAM, outsiderRoleId);
  outsiderCookie = await loginAsSteam(OUTSIDER_STEAM);

  happyPlayerId = await createPlayer(HAPPY_STEAM);
  approvePlayerId = await createPlayer(APPROVE_STEAM);
  default30PlayerId = await createPlayer(DEFAULT30_STEAM);
  permanentPlayerId = await createPlayer(PERMANENT_STEAM);
  expiryPlayerId = await createPlayer(EXPIRY_STEAM);
  await createPlayer(REJECT_STEAM);
  await createPlayer(DUP_STEAM);
  await createPlayer(FALLBACK_STEAM);

  activeServerId = uuidv7();
  await h.db
    .insert(servers)
    .values({ id: activeServerId, displayName: 'wl3-server', slug: `wl3-server-${Date.now()}` });

  await setSettings(true, null);
}, 60_000);

afterAll(async () => {
  invalidateAllPermissionCaches();
  await h.cleanup();
}, 60_000);

describeIfDb('public portal — settings + submit', () => {
  it('exposes the open/closed state without auth', async () => {
    const res = await h.app.inject({ method: 'GET', url: '/api/v1/public/whitelist/settings' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ enabled: true });
  });

  it('accepts an anonymous submission (201 pending) and audits it as a system actor', async () => {
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/v1/public/whitelist/applications',
      payload: {
        steam_id64: HAPPY_STEAM.toString(),
        body: 'main-server regular, please whitelist',
      },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json<{
      id: string;
      status: string;
      steam_id64: string;
      player_id: string | null;
    }>();
    expect(body.status).toBe('pending');
    expect(body.steam_id64).toBe(HAPPY_STEAM.toString());
    // player_id resolved best-effort (this SteamID has a players row).
    expect(body.player_id).toBe(happyPlayerId);

    const [audit] = await h.db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.actionType, 'whitelist.application.create'),
          eq(auditLog.targetId, body.id),
        ),
      )
      .orderBy(desc(auditLog.createdAt))
      .limit(1);
    expect(audit?.actorKind).toBe('system');
    expect(audit?.actorSystemLabel).toBe('http-anonymous');
  });

  it('rejects a malformed steam_id64 with 400', async () => {
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/v1/public/whitelist/applications',
      payload: { steam_id64: BAD_STEAM, body: 'hi' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects a second pending application for the same SteamID64 with 409', async () => {
    await submit(DUP_STEAM);
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/v1/public/whitelist/applications',
      payload: { steam_id64: DUP_STEAM.toString(), body: 'again' },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('application_already_pending');
  });

  it('returns 404 when the portal is closed', async () => {
    await setSettings(false, null);
    try {
      const settingsRes = await h.app.inject({
        method: 'GET',
        url: '/api/v1/public/whitelist/settings',
      });
      expect(settingsRes.json()).toEqual({ enabled: false });

      const res = await h.app.inject({
        method: 'POST',
        url: '/api/v1/public/whitelist/applications',
        payload: { steam_id64: testSteamId(167099).toString(), body: 'hi' },
      });
      expect(res.statusCode).toBe(404);
      expect(res.json().error).toBe('applications_disabled');
    } finally {
      await setSettings(true, null);
    }
  });
});

describeIfDb('panel review queue — list + gates', () => {
  it('rejects an unauthenticated list request with 401', async () => {
    const res = await h.app.inject({ method: 'GET', url: '/api/v1/whitelist/applications' });
    expect(res.statusCode).toBe(401);
  });

  it('rejects a user without whitelist:view with 403', async () => {
    const res = await h.app.inject({
      method: 'GET',
      url: '/api/v1/whitelist/applications',
      headers: { cookie: outsiderCookie },
    });
    expect(res.statusCode).toBe(403);
  });

  it('lists pending applications for the owner', async () => {
    const res = await h.app.inject({
      method: 'GET',
      url: '/api/v1/whitelist/applications?status=pending',
      headers: { cookie: ownerCookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ items: Array<{ steam_id64: string }>; total: number }>();
    expect(body.total).toBeGreaterThan(0);
    expect(body.items.some((i) => i.steam_id64 === HAPPY_STEAM.toString())).toBe(true);
  });
});

describeIfDb('panel application settings', () => {
  it('rejects settings edit for a user without whitelist:edit with 403', async () => {
    const res = await h.app.inject({
      method: 'PUT',
      url: '/api/v1/whitelist/applications/settings',
      headers: { cookie: outsiderCookie },
      payload: { enabled: true, default_days: 7 },
    });
    expect(res.statusCode).toBe(403);
  });

  it('reads and updates settings, writing an audit row', async () => {
    const getRes = await h.app.inject({
      method: 'GET',
      url: '/api/v1/whitelist/applications/settings',
      headers: { cookie: ownerCookie },
    });
    expect(getRes.statusCode).toBe(200);

    const putRes = await h.app.inject({
      method: 'PUT',
      url: '/api/v1/whitelist/applications/settings',
      headers: { cookie: ownerCookie },
      payload: { enabled: true, default_days: 14 },
    });
    expect(putRes.statusCode).toBe(200);
    expect(putRes.json()).toEqual({ enabled: true, default_days: 14 });
    await assertAuditRow(h, {
      action: 'whitelist.application.settings.update',
      resource: 'panel_meta',
    });

    // restore the shared portal state for later tests
    await setSettings(true, null);
  });
});

describeIfDb('approval — happy path grants a time-bounded role', () => {
  beforeEach(async () => {
    await h.db.delete(adminsCfgSyncOutbox);
  });

  it('approves with an explicit expiry: sets role fields + granted_* + one outbox row per active server', async () => {
    const appId = await submit(APPROVE_STEAM, 'approve me');
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

    const res = await h.app.inject({
      method: 'PATCH',
      url: `/api/v1/whitelist/applications/${appId}`,
      headers: { cookie: ownerCookie },
      payload: { status: 'approved', role_id: vipRoleId, expires_at: expiresAt.toISOString() },
    });
    expect(res.statusCode).toBe(200);
    const after = res.json<{ status: string; granted_role_id: string; granted_until: string }>();
    expect(after.status).toBe('approved');
    expect(after.granted_role_id).toBe(vipRoleId);
    expect(new Date(after.granted_until).getTime()).toBeCloseTo(expiresAt.getTime(), -3);

    const [player] = await h.db
      .select({ roleId: players.roleId, roleExpiresAt: players.roleExpiresAt })
      .from(players)
      .where(eq(players.id, approvePlayerId))
      .limit(1);
    expect(player?.roleId).toBe(vipRoleId);
    expect(player?.roleExpiresAt?.getTime()).toBeCloseTo(expiresAt.getTime(), -3);

    const rows = await outboxRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.serverId).toBe(activeServerId);
    expect(rows[0]?.reason).toBe('whitelist.application.approve');

    await assertAuditRow(h, { action: 'whitelist.application.review', targetId: appId });
  });

  it('resolves the role from panel_meta.whitelist_role_id when none is supplied', async () => {
    // configure the fallback whitelist role via the WL-1 route
    const cfg = await h.app.inject({
      method: 'PUT',
      url: '/api/v1/whitelist/settings',
      headers: { cookie: ownerCookie },
      payload: { whitelist_role_id: fallbackRoleId },
    });
    expect(cfg.statusCode).toBe(200);
    try {
      const appId = await submit(FALLBACK_STEAM);
      const res = await h.app.inject({
        method: 'PATCH',
        url: `/api/v1/whitelist/applications/${appId}`,
        headers: { cookie: ownerCookie },
        payload: { status: 'approved' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json<{ granted_role_id: string }>().granted_role_id).toBe(fallbackRoleId);
    } finally {
      await h.app.inject({
        method: 'PUT',
        url: '/api/v1/whitelist/settings',
        headers: { cookie: ownerCookie },
        payload: { whitelist_role_id: null },
      });
    }
  });
});

describeIfDb('approval — default term resolution', () => {
  it('applies default_days when no expiry is supplied', async () => {
    await setSettings(true, 30);
    try {
      const appId = await submit(DEFAULT30_STEAM);
      const res = await h.app.inject({
        method: 'PATCH',
        url: `/api/v1/whitelist/applications/${appId}`,
        headers: { cookie: ownerCookie },
        payload: { status: 'approved', role_id: vipRoleId },
      });
      expect(res.statusCode).toBe(200);
      const expected = Date.now() + 30 * 24 * 60 * 60 * 1000;
      const granted = new Date(res.json<{ granted_until: string }>().granted_until).getTime();
      expect(granted).toBeCloseTo(expected, -5);

      const [player] = await h.db
        .select({ roleExpiresAt: players.roleExpiresAt })
        .from(players)
        .where(eq(players.id, default30PlayerId))
        .limit(1);
      expect(player?.roleExpiresAt).not.toBeNull();
    } finally {
      await setSettings(true, null);
    }
  });

  it('grants permanently (null expiry) when default_days is null and no expiry is supplied', async () => {
    await setSettings(true, null);
    const appId = await submit(PERMANENT_STEAM);
    const res = await h.app.inject({
      method: 'PATCH',
      url: `/api/v1/whitelist/applications/${appId}`,
      headers: { cookie: ownerCookie },
      payload: { status: 'approved', role_id: vipRoleId },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ granted_until: string | null }>().granted_until).toBeNull();

    const [player] = await h.db
      .select({ roleId: players.roleId, roleExpiresAt: players.roleExpiresAt })
      .from(players)
      .where(eq(players.id, permanentPlayerId))
      .limit(1);
    expect(player?.roleId).toBe(vipRoleId);
    expect(player?.roleExpiresAt).toBeNull();
  });
});

describeIfDb('rejection — no role side-effects', () => {
  it('rejects without touching the player role or enqueuing a sync', async () => {
    await h.db.delete(adminsCfgSyncOutbox);
    const appId = await submit(REJECT_STEAM);
    const res = await h.app.inject({
      method: 'PATCH',
      url: `/api/v1/whitelist/applications/${appId}`,
      headers: { cookie: ownerCookie },
      payload: { status: 'rejected', review_note: 'insufficient playtime' },
    });
    expect(res.statusCode).toBe(200);
    const after = res.json<{
      status: string;
      review_note: string;
      granted_role_id: string | null;
    }>();
    expect(after.status).toBe('rejected');
    expect(after.review_note).toBe('insufficient playtime');
    expect(after.granted_role_id).toBeNull();

    const [player] = await h.db
      .select({ roleId: players.roleId })
      .from(players)
      .where(eq(players.steamId64, REJECT_STEAM))
      .limit(1);
    expect(player?.roleId).toBeNull();
    expect(await outboxRows()).toHaveLength(0);

    await assertAuditRow(h, { action: 'whitelist.application.review', targetId: appId });
  });
});

describeIfDb('approval failures', () => {
  it('returns 404 when no players row exists for the SteamID64', async () => {
    const appId = await submit(NO_PLAYER_STEAM);
    const res = await h.app.inject({
      method: 'PATCH',
      url: `/api/v1/whitelist/applications/${appId}`,
      headers: { cookie: ownerCookie },
      payload: { status: 'approved', role_id: vipRoleId },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe('player_not_found');
  });

  it('returns 409 when no role can be resolved', async () => {
    const steam = testSteamId(167020);
    await createPlayer(steam);
    const appId = await submit(steam);
    const res = await h.app.inject({
      method: 'PATCH',
      url: `/api/v1/whitelist/applications/${appId}`,
      headers: { cookie: ownerCookie },
      payload: { status: 'approved' },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('whitelist_role_not_configured');
  });

  it('returns 400 for a past expiry date', async () => {
    const steam = testSteamId(167021);
    await createPlayer(steam);
    const appId = await submit(steam);
    const res = await h.app.inject({
      method: 'PATCH',
      url: `/api/v1/whitelist/applications/${appId}`,
      headers: { cookie: ownerCookie },
      payload: {
        status: 'approved',
        role_id: vipRoleId,
        expires_at: new Date(Date.now() - 60_000).toISOString(),
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('role_expiry_must_be_future');
  });

  it('forbids self-approval with 403', async () => {
    const appId = await submit(OWNER_STEAM, 'i want whitelist');
    const res = await h.app.inject({
      method: 'PATCH',
      url: `/api/v1/whitelist/applications/${appId}`,
      headers: { cookie: ownerCookie },
      payload: { status: 'approved', role_id: vipRoleId },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe('self_approval_forbidden');
  });

  it('rejects PATCH from a user without whitelist:edit with 403', async () => {
    const steam = testSteamId(167022);
    await createPlayer(steam);
    const appId = await submit(steam);
    const res = await h.app.inject({
      method: 'PATCH',
      url: `/api/v1/whitelist/applications/${appId}`,
      headers: { cookie: outsiderCookie },
      payload: { status: 'approved', role_id: vipRoleId },
    });
    expect(res.statusCode).toBe(403);
  });

  it('is idempotent: re-deciding an already-approved application returns 409', async () => {
    const steam = testSteamId(167023);
    await createPlayer(steam);
    const appId = await submit(steam);
    const first = await h.app.inject({
      method: 'PATCH',
      url: `/api/v1/whitelist/applications/${appId}`,
      headers: { cookie: ownerCookie },
      payload: { status: 'approved', role_id: vipRoleId },
    });
    expect(first.statusCode).toBe(200);

    const second = await h.app.inject({
      method: 'PATCH',
      url: `/api/v1/whitelist/applications/${appId}`,
      headers: { cookie: ownerCookie },
      payload: { status: 'approved', role_id: vipRoleId },
    });
    expect(second.statusCode).toBe(409);
    expect(second.json().error).toBe('application_not_pending');
  });

  it('returns 404 for an unknown application id', async () => {
    const res = await h.app.inject({
      method: 'PATCH',
      url: `/api/v1/whitelist/applications/${uuidv7()}`,
      headers: { cookie: ownerCookie },
      payload: { status: 'approved', role_id: vipRoleId },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe('application_not_found');
  });
});

describeIfDb('auto-expiry chain (VIPSUB-1 reuse — acceptance criterion)', () => {
  it('a back-dated grant is cleared by the role-expirer tick, writing a player.role.expire audit + fresh sync', async () => {
    // 1. Approve a time-bounded grant through the real portal flow.
    const appId = await submit(EXPIRY_STEAM);
    const approve = await h.app.inject({
      method: 'PATCH',
      url: `/api/v1/whitelist/applications/${appId}`,
      headers: { cookie: ownerCookie },
      payload: {
        status: 'approved',
        role_id: vipRoleId,
        expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      },
    });
    expect(approve.statusCode).toBe(200);

    // 2. Back-date the assignment so the next tick considers it expired.
    const past = new Date(Date.now() - 60 * 60 * 1000);
    await h.db
      .update(players)
      .set({ roleExpiresAt: past })
      .where(eq(players.steamId64, EXPIRY_STEAM));

    // 3. Run the production role-expirer tick against the outbox publisher.
    await h.db.delete(adminsCfgSyncOutbox);
    const deps: RoleExpiryTickDeps = {
      findExpiredAssignments: (now) => findExpiredAssignments(h.db, now, 500),
      clearExpiredAssignments: (ids, now, event) => clearExpiredAssignments(h.db, ids, now, event),
      writeAuditEntry: (entry) => writeRoleExpiryAuditEntry(h.db, entry),
      invalidatePermissionCache: () => undefined,
      revokeAllForPlayer: (playerId) => revokeAllSessionsForPlayer(h.db, h.redis, playerId),
      diag: { emit: async () => undefined },
    };
    const result = await runRoleExpiryTick(deps);
    expect(result.expired).toBeGreaterThanOrEqual(1);

    // 4. Role cleared on the player.
    const [player] = await h.db
      .select({ roleId: players.roleId, roleExpiresAt: players.roleExpiresAt })
      .from(players)
      .where(eq(players.id, expiryPlayerId))
      .limit(1);
    expect(player?.roleId).toBeNull();
    expect(player?.roleExpiresAt).toBeNull();

    // 5. player.role.expire audit written for this player.
    await assertAuditRow(h, { action: 'player.role.expire', targetId: expiryPlayerId });

    // 6. A fresh Admins.cfg sync was enqueued for every active server.
    const rows = await outboxRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.serverId).toBe(activeServerId);
    expect(rows[0]?.reason).toBe('player.role.expire');
  });
});
