import { auditLog, coplaySettings, playerCoplay, players, servers } from '@squad/db/schema';
import { and, eq, gt, max } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { invalidateAllPermissionCaches } from '../../src/lib/rbac.js';
import { createSession } from '../../src/lib/sessions.js';
import { testSteamId } from '../helpers/snapshot-restore.js';
import {
  buildIntegrationApp,
  type IntegrationHarness,
  loginAsOwner,
  makeFakeBridge,
} from './harness.js';

const OWNER_STEAM = testSteamId(830001);
const TEST_PLAYER_LIMITED_VIEWER = testSteamId(830002);

let h: IntegrationHarness;
let auditBaseline = 0n;

beforeAll(async () => {
  h = await buildIntegrationApp({
    seedOwner: { steamId64: OWNER_STEAM },
    bridge: makeFakeBridge(),
  });
});

afterAll(async () => {
  await h.cleanup();
});

beforeEach(async () => {
  const [latest] = await h.db.select({ id: max(auditLog.id) }).from(auditLog);
  auditBaseline = latest?.id ?? 0n;
});

// Cases assert thresholds against the migration defaults and two of them seed
// the same limited viewer: re-create the singleton row exactly as migration
// 0036 does and drop that viewer.
afterEach(async () => {
  await h.db.delete(coplaySettings);
  await h.db.insert(coplaySettings).values({ id: 1 });
  await h.db.delete(players).where(eq(players.steamId64, TEST_PLAYER_LIMITED_VIEWER));
  invalidateAllPermissionCaches();
});

/**
 * Waits for an audit row written during the current case. `assertAuditRow`
 * accepts any recent matching row, and on this shared harness every PUT case
 * writes `coplay.settings.update`, so it could pass on an earlier case's row.
 */
async function expectAuditRowFromThisCase(action: string, resource: string): Promise<void> {
  await expect
    .poll(
      async () =>
        (
          await h.db
            .select({ id: auditLog.id })
            .from(auditLog)
            .where(
              and(
                eq(auditLog.actionType, action),
                eq(auditLog.targetType, resource),
                gt(auditLog.id, auditBaseline),
              ),
            )
        ).length,
      { timeout: 1_200, interval: 50 },
    )
    .toBeGreaterThan(0);
}

async function loginAsRoleWithoutViewIps(): Promise<string> {
  const [row] = await h.db
    .insert(players)
    .values({
      steamId64: TEST_PLAYER_LIMITED_VIEWER,
      canonicalName: 'LimitedViewer',
      canonicalNameNormalized: 'limitedviewer',
    })
    .returning({ id: players.id });

  const ownerCookie = await loginAsOwner(h);
  const created = await h.app.inject({
    method: 'POST',
    url: '/api/v1/roles',
    headers: { cookie: ownerCookie, 'content-type': 'application/json' },
    payload: JSON.stringify({
      name: `no-view-ips-${Date.now()}`,
      color: '#123456',
      squad_permissions: [],
      panel_access: true,
      can_view_ips: false,
    }),
  });
  const roleId = (created.json() as { id: string }).id;
  await h.db
    .update(players)
    .set({ roleId })
    .where(eq(players.steamId64, TEST_PLAYER_LIMITED_VIEWER));
  invalidateAllPermissionCaches();

  const { token } = await createSession(h.db, h.redis, {
    playerId: row.id,
    ip: null,
    userAgent: 'settings-coplay-test',
    ttlMs: 21_600_000,
  });
  return `__Host-sid=${token}`;
}

describe('GET /api/v1/settings/coplay', () => {
  it('returns the seeded defaults when the singleton row is absent', async () => {
    const cookie = await loginAsOwner(h);
    const res = await h.app.inject({
      method: 'GET',
      url: '/api/v1/settings/coplay',
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      min_shared_sessions: 5,
      min_overlap_seconds: 36_000,
    });
  });

  it('rejects an unauthenticated request', async () => {
    const res = await h.app.inject({ method: 'GET', url: '/api/v1/settings/coplay' });
    expect(res.statusCode).toBe(401);
  });

  it('allows a role without player:view_ips as long as it has panel_access', async () => {
    const cookie = await loginAsRoleWithoutViewIps();
    const res = await h.app.inject({
      method: 'GET',
      url: '/api/v1/settings/coplay',
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
  });
});

describe('PUT /api/v1/settings/coplay', () => {
  it('updates both thresholds and a subsequent GET reflects them', async () => {
    const cookie = await loginAsOwner(h);
    const put = await h.app.inject({
      method: 'PUT',
      url: '/api/v1/settings/coplay',
      headers: { cookie, 'content-type': 'application/json' },
      payload: JSON.stringify({ min_shared_sessions: 3, min_overlap_seconds: 1_800 }),
    });
    expect(put.statusCode).toBe(200);
    expect(put.json()).toMatchObject({ min_shared_sessions: 3, min_overlap_seconds: 1_800 });

    const get = await h.app.inject({
      method: 'GET',
      url: '/api/v1/settings/coplay',
      headers: { cookie },
    });
    expect(get.json()).toMatchObject({ min_shared_sessions: 3, min_overlap_seconds: 1_800 });
  });

  it('updates only the field present in a partial body', async () => {
    const cookie = await loginAsOwner(h);
    await h.app.inject({
      method: 'PUT',
      url: '/api/v1/settings/coplay',
      headers: { cookie, 'content-type': 'application/json' },
      payload: JSON.stringify({ min_shared_sessions: 2 }),
    });
    const get = await h.app.inject({
      method: 'GET',
      url: '/api/v1/settings/coplay',
      headers: { cookie },
    });
    expect(get.json()).toMatchObject({ min_shared_sessions: 2, min_overlap_seconds: 36_000 });
  });

  it('rejects an empty body with 400', async () => {
    const cookie = await loginAsOwner(h);
    const res = await h.app.inject({
      method: 'PUT',
      url: '/api/v1/settings/coplay',
      headers: { cookie, 'content-type': 'application/json' },
      payload: JSON.stringify({}),
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects an unauthenticated request', async () => {
    const res = await h.app.inject({
      method: 'PUT',
      url: '/api/v1/settings/coplay',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ min_shared_sessions: 1 }),
    });
    expect(res.statusCode).toBe(401);
  });

  it('rejects a panel user without player:view_ips with 403', async () => {
    const cookie = await loginAsRoleWithoutViewIps();
    const res = await h.app.inject({
      method: 'PUT',
      url: '/api/v1/settings/coplay',
      headers: { cookie, 'content-type': 'application/json' },
      payload: JSON.stringify({ min_shared_sessions: 1 }),
    });
    expect(res.statusCode).toBe(403);
  });

  it('writes an audit entry on update', async () => {
    const cookie = await loginAsOwner(h);
    await h.app.inject({
      method: 'PUT',
      url: '/api/v1/settings/coplay',
      headers: { cookie, 'content-type': 'application/json' },
      payload: JSON.stringify({ min_overlap_seconds: 60 }),
    });
    await expectAuditRowFromThisCase('coplay.settings.update', 'coplay_settings');
  });

  it('wires settings -> coplay route end-to-end: lowering thresholds reveals a previously-hidden pair', async () => {
    const ownerCookie = await loginAsOwner(h);

    const [server] = await h.db
      .insert(servers)
      .values({
        id: uuidv7(),
        displayName: 'CoplaySettingsServer',
        slug: `coplay-settings-${uuidv7()}`,
      })
      .returning({ id: servers.id });
    const [alice] = await h.db
      .insert(players)
      .values({
        steamId64: testSteamId(830010),
        canonicalName: 'CoplaySettingsAlice',
        canonicalNameNormalized: 'coplaysettingsalice',
      })
      .returning({ id: players.id });
    const [bob] = await h.db
      .insert(players)
      .values({
        steamId64: testSteamId(830011),
        canonicalName: 'CoplaySettingsBob',
        canonicalNameNormalized: 'coplaysettingsbob',
      })
      .returning({ id: players.id });
    const [a, b] = alice.id < bob.id ? [alice.id, bob.id] : [bob.id, alice.id];
    // Below the default thresholds (5 sessions / 36 000s): only 1 session, 100s overlap.
    await h.db.insert(playerCoplay).values({
      playerAId: a,
      playerBId: b,
      serverId: server.id,
      windowStart: new Date().toISOString().slice(0, 10),
      overlapSeconds: 100,
      sharedSessionCount: 1,
    });

    const beforePut = await h.app.inject({
      method: 'GET',
      url: `/api/v1/players/${alice.id}/coplay`,
      headers: { cookie: ownerCookie },
    });
    const beforeBody = beforePut.json() as { partners: Array<{ player_id: string }> };
    expect(beforeBody.partners.map((p) => p.player_id)).not.toContain(bob.id);

    const put = await h.app.inject({
      method: 'PUT',
      url: '/api/v1/settings/coplay',
      headers: { cookie: ownerCookie, 'content-type': 'application/json' },
      payload: JSON.stringify({ min_shared_sessions: 1, min_overlap_seconds: 1 }),
    });
    expect(put.statusCode).toBe(200);

    const afterPut = await h.app.inject({
      method: 'GET',
      url: `/api/v1/players/${alice.id}/coplay`,
      headers: { cookie: ownerCookie },
    });
    const afterBody = afterPut.json() as { partners: Array<{ player_id: string }> };
    expect(afterBody.partners.map((p) => p.player_id)).toContain(bob.id);
  });
});
