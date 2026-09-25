import { auditLog, players, roles } from '@squad/db/schema';
import { and, desc, eq, gt } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { invalidatePermissionCache } from '../src/lib/rbac.js';
import {
  buildIntegrationApp,
  type IntegrationHarness,
  loginAsOwner,
  makeFakeBridge,
} from './integration/harness.js';

const OWNER_STEAM_ID = 76561198000000999n;

let h: IntegrationHarness;
let ownerRoleId: string;
let auditMark: bigint;

beforeAll(async () => {
  h = await buildIntegrationApp({
    seedOwner: { steamId64: OWNER_STEAM_ID },
    seedOwnerGuard: true,
    bridge: makeFakeBridge(),
  });
  const [ownerRole] = await h.db
    .select({ id: roles.id })
    .from(roles)
    .where(and(eq(roles.name, 'Owner'), eq(roles.isSystemRole, true)))
    .limit(1);
  if (!ownerRole) throw new Error('Owner role missing');
  ownerRoleId = ownerRole.id;
});

beforeEach(async () => {
  // Several cases demote the seeded owner or swap hostAgentRestart; start
  // each one as a full Owner talking to the stock fake bridge.
  await h.db
    .update(players)
    .set({ roleId: ownerRoleId })
    .where(eq(players.steamId64, OWNER_STEAM_ID));
  Object.assign(h.bridge, makeFakeBridge());
  const [latest] = await h.db
    .select({ id: auditLog.id })
    .from(auditLog)
    .orderBy(desc(auditLog.id))
    .limit(1);
  auditMark = latest?.id ?? 0n;
});

afterEach(async () => {
  if (h.seed.ownerSteamId64 && h.seed.ownerPlayerId) {
    invalidatePermissionCache(h.seed.ownerPlayerId);
  }
});

afterAll(async () => {
  await h?.cleanup();
});

/**
 * Waits for an audit row this test wrote. A host restart audits no target id,
 * so rows from earlier tests in the file are excluded by id instead.
 */
async function expectAuditRowSinceTestStart(action: string, resource: string): Promise<void> {
  await expect
    .poll(
      async () =>
        (
          await h.db
            .select({ id: auditLog.id })
            .from(auditLog)
            .where(
              and(
                gt(auditLog.id, auditMark),
                eq(auditLog.actionType, action),
                eq(auditLog.targetType, resource),
              ),
            )
            .limit(1)
        ).length,
      { timeout: 1_200, interval: 50 },
    )
    .toBe(1);
}

async function demoteToNoRole(h: IntegrationHarness): Promise<void> {
  if (!h.seed.ownerSteamId64 || !h.seed.ownerPlayerId) throw new Error('owner steam id missing');
  await h.db
    .update(players)
    .set({ roleId: null })
    .where(eq(players.steamId64, h.seed.ownerSteamId64));
  invalidatePermissionCache(h.seed.ownerPlayerId);
}

describe('POST /api/v1/host/restart', () => {
  it('Owner with host:manage permission triggers a restart and writes an audit row', async () => {
    let calls = 0;
    h.bridge.hostAgentRestart = async () => {
      calls++;
      return { status: 'restarting' as const };
    };
    const cookie = await loginAsOwner(h);
    const resp = await h.app.inject({
      method: 'POST',
      url: '/api/v1/host/restart',
      headers: { cookie },
    });
    expect(resp.statusCode).toBe(200);
    expect(resp.json()).toEqual({ status: 'restarting' });
    expect(calls).toBe(1);
    await expectAuditRowSinceTestStart('host.bridge.restart', 'host');
  });

  it('viewer without host:manage permission is rejected with 403', async () => {
    const viewerRoleRows = await h.db
      .select({ id: roles.id })
      .from(roles)
      .where(eq(roles.name, 'Viewer'))
      .limit(1);
    const viewerRoleId = viewerRoleRows[0]?.id;
    if (!viewerRoleId || !h.seed.ownerSteamId64 || !h.seed.ownerPlayerId) {
      throw new Error('viewer role missing');
    }
    await h.db
      .update(players)
      .set({ roleId: viewerRoleId })
      .where(eq(players.steamId64, h.seed.ownerSteamId64));
    invalidatePermissionCache(h.seed.ownerPlayerId);

    const cookie = await loginAsOwner(h);
    const resp = await h.app.inject({
      method: 'POST',
      url: '/api/v1/host/restart',
      headers: { cookie },
    });
    expect(resp.statusCode).toBe(403);
  });

  it('treats connection-reset from the bridge as success because the side-effect already happened', async () => {
    h.bridge.hostAgentRestart = async () => {
      throw new Error('socket closed');
    };
    const cookie = await loginAsOwner(h);
    const resp = await h.app.inject({
      method: 'POST',
      url: '/api/v1/host/restart',
      headers: { cookie },
    });
    expect(resp.statusCode).toBe(200);
    expect(resp.json()).toEqual({ status: 'restarting' });
  });

  it('propagates a hard 5xx when the bridge returns a non-connection error', async () => {
    h.bridge.hostAgentRestart = async () => {
      throw new Error('internal bridge failure');
    };
    const cookie = await loginAsOwner(h);
    const resp = await h.app.inject({
      method: 'POST',
      url: '/api/v1/host/restart',
      headers: { cookie },
    });
    expect(resp.statusCode).toBe(502);
    expect(resp.json()).toMatchObject({ error: 'bridge_unreachable' });
  });

  it('returns 401 when not authenticated', async () => {
    const resp = await h.app.inject({ method: 'POST', url: '/api/v1/host/restart' });
    expect(resp.statusCode).toBe(401);
  });
});

describe('GET /api/v1/host/info', () => {
  it('returns host info for a user with host:view permission', async () => {
    const cookie = await loginAsOwner(h);
    const resp = await h.app.inject({
      method: 'GET',
      url: '/api/v1/host/info',
      headers: { cookie },
    });
    expect(resp.statusCode).toBe(200);
    const body = resp.json() as { hostname: string; cpu_cores: number };
    expect(typeof body.hostname).toBe('string');
    expect(typeof body.cpu_cores).toBe('number');
  });

  it('returns 401 without a session', async () => {
    const resp = await h.app.inject({ method: 'GET', url: '/api/v1/host/info' });
    expect(resp.statusCode).toBe(401);
  });

  it('returns 403 for Viewer who lacks host:view', async () => {
    await demoteToNoRole(h);
    const cookie = await loginAsOwner(h);
    const resp = await h.app.inject({
      method: 'GET',
      url: '/api/v1/host/info',
      headers: { cookie },
    });
    expect(resp.statusCode).toBe(403);
  });
});

describe('GET /api/v1/host/metrics/history', () => {
  it('returns ts/v arrays (empty when no data in stream)', async () => {
    const cookie = await loginAsOwner(h);
    const resp = await h.app.inject({
      method: 'GET',
      url: '/api/v1/host/metrics/history',
      headers: { cookie },
    });
    expect(resp.statusCode).toBe(200);
    const body = resp.json() as { ts: number[]; v: number[][] };
    expect(Array.isArray(body.ts)).toBe(true);
    expect(Array.isArray(body.v)).toBe(true);
  });

  it('accepts the ?seconds= query param and clamps values', async () => {
    const cookie = await loginAsOwner(h);
    const ok = await h.app.inject({
      method: 'GET',
      url: '/api/v1/host/metrics/history?seconds=3600',
      headers: { cookie },
    });
    expect(ok.statusCode).toBe(200);

    const bad = await h.app.inject({
      method: 'GET',
      url: '/api/v1/host/metrics/history?seconds=0',
      headers: { cookie },
    });
    expect([400, 422]).toContain(bad.statusCode);
  });

  it('returns 401 without a session', async () => {
    const resp = await h.app.inject({
      method: 'GET',
      url: '/api/v1/host/metrics/history',
    });
    expect(resp.statusCode).toBe(401);
  });

  it('returns 403 for Viewer who lacks host:metrics', async () => {
    await demoteToNoRole(h);
    const cookie = await loginAsOwner(h);
    const resp = await h.app.inject({
      method: 'GET',
      url: '/api/v1/host/metrics/history',
      headers: { cookie },
    });
    expect(resp.statusCode).toBe(403);
  });
});
