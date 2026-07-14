import { altIgnoredIps, players } from '@squad/db/schema';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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

const OWNER_STEAM = testSteamId(820001);
const TEST_PLAYER_LIMITED_VIEWER = testSteamId(820002);

let h: IntegrationHarness;

beforeEach(async () => {
  h = await buildIntegrationApp({
    seedOwner: { steamId64: OWNER_STEAM },
    bridge: makeFakeBridge(),
  });
});

afterEach(async () => {
  if (h) await h.cleanup();
});

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
    userAgent: 'settings-alt-detection-test',
    ttlMs: 21_600_000,
  });
  return `__Host-sid=${token}`;
}

describe('GET /api/v1/settings/alt-detection', () => {
  it('returns the seeded defaults when the singleton row is absent', async () => {
    const cookie = await loginAsOwner(h);
    const res = await h.app.inject({
      method: 'GET',
      url: '/api/v1/settings/alt-detection',
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      settings: { weight_shared_ip: number; medium_threshold: number; high_threshold: number };
      ignored_ips: unknown[];
    };
    expect(body.settings).toMatchObject({
      weight_shared_ip: 50,
      weight_shared_name: 25,
      weight_young_account: 15,
      weight_steamid_proximity: 10,
      steamid_delta_threshold: 10_000,
      medium_threshold: 50,
      high_threshold: 75,
    });
    expect(body.ignored_ips).toEqual([]);
  });

  it('includes the ALT-3 co-play anti-signal defaults', async () => {
    const cookie = await loginAsOwner(h);
    const res = await h.app.inject({
      method: 'GET',
      url: '/api/v1/settings/alt-detection',
      headers: { cookie },
    });
    const body = res.json() as {
      settings: { weight_coplay_overlap: number; coplay_overlap_threshold_seconds: number };
    };
    expect(body.settings).toMatchObject({
      weight_coplay_overlap: 30,
      coplay_overlap_threshold_seconds: 36_000,
    });
  });

  it('rejects an unauthenticated request', async () => {
    const res = await h.app.inject({ method: 'GET', url: '/api/v1/settings/alt-detection' });
    expect(res.statusCode).toBe(401);
  });

  it('rejects a role without can_view_ips', async () => {
    const cookie = await loginAsRoleWithoutViewIps();
    const res = await h.app.inject({
      method: 'GET',
      url: '/api/v1/settings/alt-detection',
      headers: { cookie },
    });
    expect(res.statusCode).toBe(403);
  });
});

describe('PUT /api/v1/settings/alt-detection', () => {
  it('upserts the singleton and a subsequent GET reflects the update', async () => {
    const cookie = await loginAsOwner(h);
    const put = await h.app.inject({
      method: 'PUT',
      url: '/api/v1/settings/alt-detection',
      headers: { cookie, 'content-type': 'application/json' },
      payload: JSON.stringify({ weight_shared_ip: 80, medium_threshold: 40 }),
    });
    expect(put.statusCode).toBe(200);
    expect((put.json() as { weight_shared_ip: number }).weight_shared_ip).toBe(80);

    const get = await h.app.inject({
      method: 'GET',
      url: '/api/v1/settings/alt-detection',
      headers: { cookie },
    });
    const body = get.json() as { settings: { weight_shared_ip: number; medium_threshold: number } };
    expect(body.settings.weight_shared_ip).toBe(80);
    expect(body.settings.medium_threshold).toBe(40);

    await assertAuditRow(h, {
      action: 'alt_detection.settings.update',
      resource: 'alt_detection_settings',
    });
  });

  it('round-trips weight_coplay_overlap and coplay_overlap_threshold_seconds', async () => {
    const cookie = await loginAsOwner(h);
    const put = await h.app.inject({
      method: 'PUT',
      url: '/api/v1/settings/alt-detection',
      headers: { cookie, 'content-type': 'application/json' },
      payload: JSON.stringify({
        weight_coplay_overlap: 45,
        coplay_overlap_threshold_seconds: 7_200,
      }),
    });
    expect(put.statusCode).toBe(200);
    expect(put.json()).toMatchObject({
      weight_coplay_overlap: 45,
      coplay_overlap_threshold_seconds: 7_200,
    });

    const get = await h.app.inject({
      method: 'GET',
      url: '/api/v1/settings/alt-detection',
      headers: { cookie },
    });
    const body = get.json() as {
      settings: { weight_coplay_overlap: number; coplay_overlap_threshold_seconds: number };
    };
    expect(body.settings).toMatchObject({
      weight_coplay_overlap: 45,
      coplay_overlap_threshold_seconds: 7_200,
    });
  });

  it('rejects a negative weight_coplay_overlap with 400', async () => {
    const cookie = await loginAsOwner(h);
    const res = await h.app.inject({
      method: 'PUT',
      url: '/api/v1/settings/alt-detection',
      headers: { cookie, 'content-type': 'application/json' },
      payload: JSON.stringify({ weight_coplay_overlap: -1 }),
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects a negative coplay_overlap_threshold_seconds with 400', async () => {
    const cookie = await loginAsOwner(h);
    const res = await h.app.inject({
      method: 'PUT',
      url: '/api/v1/settings/alt-detection',
      headers: { cookie, 'content-type': 'application/json' },
      payload: JSON.stringify({ coplay_overlap_threshold_seconds: -1 }),
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects medium_threshold above high_threshold with 400', async () => {
    const cookie = await loginAsOwner(h);
    const res = await h.app.inject({
      method: 'PUT',
      url: '/api/v1/settings/alt-detection',
      headers: { cookie, 'content-type': 'application/json' },
      payload: JSON.stringify({ medium_threshold: 90, high_threshold: 80 }),
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects a role without can_view_ips', async () => {
    const cookie = await loginAsRoleWithoutViewIps();
    const res = await h.app.inject({
      method: 'PUT',
      url: '/api/v1/settings/alt-detection',
      headers: { cookie, 'content-type': 'application/json' },
      payload: JSON.stringify({ weight_shared_ip: 1 }),
    });
    expect(res.statusCode).toBe(403);
  });
});

describe('POST/DELETE /api/v1/settings/alt-detection/ignored-ips', () => {
  it('accepts a bare IPv4 and a CIDR block', async () => {
    const cookie = await loginAsOwner(h);
    const bareIp = await h.app.inject({
      method: 'POST',
      url: '/api/v1/settings/alt-detection/ignored-ips',
      headers: { cookie, 'content-type': 'application/json' },
      payload: JSON.stringify({ cidr: '10.0.0.5', note: 'office VPN exit' }),
    });
    expect(bareIp.statusCode).toBe(201);

    const cidrBlock = await h.app.inject({
      method: 'POST',
      url: '/api/v1/settings/alt-detection/ignored-ips',
      headers: { cookie, 'content-type': 'application/json' },
      payload: JSON.stringify({ cidr: '192.168.0.0/16' }),
    });
    expect(cidrBlock.statusCode).toBe(201);

    await assertAuditRow(h, {
      action: 'alt_detection.ignored_ip.create',
      resource: 'alt_ignored_ip',
    });
  });

  it('rejects malformed input with 400', async () => {
    const cookie = await loginAsOwner(h);
    for (const bad of ['999.1.2.3', 'abc', '10.0.0.1/8']) {
      const res = await h.app.inject({
        method: 'POST',
        url: '/api/v1/settings/alt-detection/ignored-ips',
        headers: { cookie, 'content-type': 'application/json' },
        payload: JSON.stringify({ cidr: bad }),
      });
      expect(res.statusCode).toBe(400);
    }
  });

  it('rejects a duplicate CIDR with 409', async () => {
    const cookie = await loginAsOwner(h);
    await h.app.inject({
      method: 'POST',
      url: '/api/v1/settings/alt-detection/ignored-ips',
      headers: { cookie, 'content-type': 'application/json' },
      payload: JSON.stringify({ cidr: '203.0.113.0/24' }),
    });
    const dup = await h.app.inject({
      method: 'POST',
      url: '/api/v1/settings/alt-detection/ignored-ips',
      headers: { cookie, 'content-type': 'application/json' },
      payload: JSON.stringify({ cidr: '203.0.113.0/24' }),
    });
    expect(dup.statusCode).toBe(409);
  });

  it('deletes an entry, and 404s on repeat delete', async () => {
    const cookie = await loginAsOwner(h);
    const [row] = await h.db.insert(altIgnoredIps).values({ cidr: '198.51.100.0/24' }).returning();

    const del = await h.app.inject({
      method: 'DELETE',
      url: `/api/v1/settings/alt-detection/ignored-ips/${row.id}`,
      headers: { cookie },
    });
    expect(del.statusCode).toBe(200);

    const again = await h.app.inject({
      method: 'DELETE',
      url: `/api/v1/settings/alt-detection/ignored-ips/${row.id}`,
      headers: { cookie },
    });
    expect(again.statusCode).toBe(404);

    await assertAuditRow(h, {
      action: 'alt_detection.ignored_ip.delete',
      resource: 'alt_ignored_ip',
      targetId: row.id,
    });
  });

  it('rejects a role without can_view_ips on both routes', async () => {
    const cookie = await loginAsRoleWithoutViewIps();
    const post = await h.app.inject({
      method: 'POST',
      url: '/api/v1/settings/alt-detection/ignored-ips',
      headers: { cookie, 'content-type': 'application/json' },
      payload: JSON.stringify({ cidr: '10.0.0.5' }),
    });
    expect(post.statusCode).toBe(403);

    const del = await h.app.inject({
      method: 'DELETE',
      url: `/api/v1/settings/alt-detection/ignored-ips/00000000-0000-0000-0000-000000000000`,
      headers: { cookie },
    });
    expect(del.statusCode).toBe(403);
  });
});
