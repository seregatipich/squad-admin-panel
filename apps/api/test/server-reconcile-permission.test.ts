import { servers } from '@squad/db/schema';
import { and, eq } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { narrowedOwnerHeaders } from './helpers/narrowed-token.js';
import { buildIntegrationApp, type IntegrationHarness } from './integration/harness.js';

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
    const serverId = uuidv7();
    await h.db.insert(servers).values({
      id: serverId,
      displayName: 'Reconcile perm test',
      slug: `reconcile-perm-${serverId.slice(0, 8)}`,
      status: 'running',
    });

    const resp = await h.app.inject({
      method: 'POST',
      url: `/api/v1/servers/${serverId}/reconcile`,
      headers: await narrowedOwnerHeaders(h, ['server:view']),
    });

    expect(resp.statusCode).toBe(403);

    await h.db.delete(servers).where(and(eq(servers.id, serverId)));
  });
});
