import { playerRoleAssignments } from '@squad/db/schema';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { invalidatePermissionCache } from '../src/lib/rbac.js';
import {
  assertAuditRow,
  buildIntegrationApp,
  type IntegrationHarness,
  loginAsOwner,
  makeFakeBridge,
} from './integration/harness.js';

const OWNER_STEAM_ID = 76561198000000999n;

let h: IntegrationHarness;

beforeEach(async () => {
  h = await buildIntegrationApp({
    seedOwner: { steamId64: OWNER_STEAM_ID },
    bridge: makeFakeBridge(),
  });
});

afterEach(async () => {
  if (h.seed.ownerSteamId64) invalidatePermissionCache(h.seed.ownerSteamId64);
  await h.cleanup();
});

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
    await assertAuditRow(h, { action: 'host.bridge.restart', resource: 'host' });
  });

  it('viewer without host:manage permission is rejected with 403', async () => {
    const viewerRole = await h.db.query.roles.findFirst({
      where: (r, { and, eq: e }) => and(e(r.orgId, h.seed.orgId!), e(r.name, 'Viewer')),
    });
    if (!viewerRole || !h.seed.ownerSteamId64) throw new Error('viewer role missing');
    await h.db
      .delete(playerRoleAssignments)
      .where(eq(playerRoleAssignments.steamId64, h.seed.ownerSteamId64));
    await h.db
      .insert(playerRoleAssignments)
      .values({ steamId64: h.seed.ownerSteamId64, roleId: viewerRole.id });
    invalidatePermissionCache(h.seed.ownerSteamId64);

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
});
