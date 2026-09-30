import { roles, servers } from '@squad/db/schema';
import { and, eq } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { invalidatePermissionCache } from '../src/lib/rbac.js';
import {
  buildIntegrationApp,
  type IntegrationHarness,
  loginAsOwner,
} from './integration/harness.js';

// Regression test for finding #342: POST /api/v1/servers/:id/reconcile
// triggers a bridge containerInspect call, a DB status write, a live-event
// publish, and an audit entry, so it must require a mutating permission
// (server:restart), not the read-only server:view.
const OWNER_STEAM_ID = 76561198000000342n;

let h: IntegrationHarness;

beforeAll(async () => {
  h = await buildIntegrationApp({
    seedOwner: { steamId64: OWNER_STEAM_ID },
    seedOwnerGuard: true,
  });
});

afterAll(async () => {
  await h.cleanup();
});

describe('POST /api/v1/servers/:id/reconcile', () => {
  it('rejects a Viewer (server:view only) with 403', async () => {
    const [viewerRole] = await h.db
      .select({ id: roles.id })
      .from(roles)
      .where(eq(roles.name, 'Viewer'))
      .limit(1);
    if (!viewerRole || !h.seed.ownerSteamId64 || !h.seed.ownerPlayerId) {
      throw new Error('viewer role or seeded owner missing');
    }
    const { players } = await import('@squad/db/schema');
    await h.db
      .update(players)
      .set({ roleId: viewerRole.id })
      .where(eq(players.steamId64, h.seed.ownerSteamId64));
    invalidatePermissionCache(h.seed.ownerPlayerId);

    const serverId = uuidv7();
    await h.db.insert(servers).values({
      id: serverId,
      displayName: 'Reconcile perm test',
      slug: `reconcile-perm-${serverId.slice(0, 8)}`,
      status: 'running',
    });

    const cookie = await loginAsOwner(h);
    const resp = await h.app.inject({
      method: 'POST',
      url: `/api/v1/servers/${serverId}/reconcile`,
      headers: { cookie },
    });

    expect(resp.statusCode).toBe(403);

    await h.db.delete(servers).where(and(eq(servers.id, serverId)));
  });
});
