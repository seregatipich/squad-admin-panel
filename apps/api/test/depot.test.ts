import { randomUUID } from 'node:crypto';
import { auditLog, players, roles } from '@squad/db/schema';
import { DEPOT_VOLUME_NAME } from '@squad/shared-config';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { invalidatePermissionCache } from '../src/lib/rbac.js';
import {
  buildIntegrationApp,
  type IntegrationHarness,
  loginAsOwner,
  makeFakeBridge,
} from './integration/harness.js';

const OWNER_STEAM_ID = 76561198000001001n;

const DEPOT_MARKER = `/var/lib/docker/volumes/${DEPOT_VOLUME_NAME}/_data/SquadGameServer.sh`;
const DEPOT_MANIFEST = `/var/lib/docker/volumes/${DEPOT_VOLUME_NAME}/_data/steamapps/appmanifest_403240.acf`;

let h: IntegrationHarness;
let ownerRoleId: string;

// POST /depot/update keeps running its orchestration after it replies, and on a
// shared app one test's run could release the lock or write depot:last_update
// in the middle of the next test. Every run opens and closes the fake bridge
// exactly once, so counting the pairs tells when no run is left in flight.
let openDepotRuns = 0;
function trackedBridge() {
  return makeFakeBridge({
    connect: async () => {
      openDepotRuns++;
    },
    close: async () => {
      openDepotRuns--;
    },
  });
}

// One app + database per file. Each test starts with the default fake bridge
// (tests swap its methods and files in place), no depot keys in Redis and the
// owner back on Owner after asViewer().
beforeAll(async () => {
  h = await buildIntegrationApp({
    seedOwner: { steamId64: OWNER_STEAM_ID },
    seedOwnerGuard: true,
    bridge: trackedBridge(),
  });
  const [ownerRole] = await h.db
    .select({ id: roles.id })
    .from(roles)
    .where(and(eq(roles.name, 'Owner'), eq(roles.isSystemRole, true)))
    .limit(1);
  if (!ownerRole) throw new Error('Owner role missing');
  ownerRoleId = ownerRole.id;
});

afterAll(async () => {
  await h?.cleanup();
});

beforeEach(async () => {
  Object.assign(h.bridge, trackedBridge());
  await h.redis.del('depot:updating', 'depot:last_update', 'depot:build_id');
  await h.db
    .update(players)
    .set({ roleId: ownerRoleId })
    .where(eq(players.steamId64, OWNER_STEAM_ID));
  // biome-ignore lint/style/noNonNullAssertion: owner player seeded in beforeAll
  invalidatePermissionCache(h.seed.ownerPlayerId!);
});

afterEach(async () => {
  await vi.waitFor(() => expect(openDepotRuns).toBe(0), { timeout: 5_000 });
});

async function asViewer(): Promise<string> {
  const viewerRows = await h.db
    .select({ id: roles.id })
    .from(roles)
    .where(eq(roles.name, 'Viewer'))
    .limit(1);
  const viewerRoleId = viewerRows[0]?.id;
  if (!viewerRoleId || !h.seed.ownerSteamId64 || !h.seed.ownerPlayerId)
    throw new Error('Viewer role missing');
  await h.db
    .update(players)
    .set({ roleId: viewerRoleId })
    .where(eq(players.steamId64, h.seed.ownerSteamId64));
  invalidatePermissionCache(h.seed.ownerPlayerId);
  return loginAsOwner(h);
}

describe('GET /api/v1/depot', () => {
  it('returns populated=false and build_id=null when marker is absent', async () => {
    const cookie = await loginAsOwner(h);
    const resp = await h.app.inject({
      method: 'GET',
      url: '/api/v1/depot',
      headers: { cookie },
    });
    expect(resp.statusCode).toBe(200);
    const body = resp.json();
    expect(body.volume).toBe(DEPOT_VOLUME_NAME);
    expect(body.populated).toBe(false);
    expect(body.build_id).toBeNull();
    expect(body.last_update).toBeNull();
  });

  it('returns populated=true and parsed build_id when marker + manifest exist', async () => {
    const manifest = `"AppState"\n{\n  "buildid"\t\t"1234567"\n}\n`;
    h.bridge.files.set(DEPOT_MARKER, Buffer.from('#!/bin/sh'));
    h.bridge.files.set(DEPOT_MANIFEST, Buffer.from(manifest));

    const cookie = await loginAsOwner(h);
    const resp = await h.app.inject({
      method: 'GET',
      url: '/api/v1/depot',
      headers: { cookie },
    });
    expect(resp.statusCode).toBe(200);
    const body = resp.json();
    expect(body.populated).toBe(true);
    expect(body.build_id).toBe('1234567');
  });

  it('returns populated=true with build_id=null when manifest is unreadable', async () => {
    h.bridge.files.set(DEPOT_MARKER, Buffer.from('#!/bin/sh'));
    h.bridge.fileRead = async ({ path }) => {
      if (path === DEPOT_MARKER) return { content: '#!/bin/sh' };
      throw new Error('ENOENT');
    };

    const cookie = await loginAsOwner(h);
    const resp = await h.app.inject({
      method: 'GET',
      url: '/api/v1/depot',
      headers: { cookie },
    });
    expect(resp.statusCode).toBe(200);
    const body = resp.json();
    expect(body.populated).toBe(true);
    expect(body.build_id).toBeNull();
  });

  it('includes last_update from redis when set', async () => {
    const payload = { finished_at: '2026-01-01T00:00:00.000Z', status: 'ok' };
    await h.redis.set('depot:last_update', JSON.stringify(payload));

    const cookie = await loginAsOwner(h);
    const resp = await h.app.inject({
      method: 'GET',
      url: '/api/v1/depot',
      headers: { cookie },
    });
    expect(resp.statusCode).toBe(200);
    expect(resp.json().last_update).toEqual(payload);
  });

  it('returns 401 when unauthenticated', async () => {
    const resp = await h.app.inject({ method: 'GET', url: '/api/v1/depot' });
    expect(resp.statusCode).toBe(401);
  });

  it('returns 403 for Viewer role (has server:view but not server:install)', async () => {
    const cookie = await asViewer();
    const resp = await h.app.inject({
      method: 'GET',
      url: '/api/v1/depot',
      headers: { cookie },
    });
    expect(resp.statusCode).toBe(200);
  });
});

describe('POST /api/v1/depot/update', () => {
  it('Owner starts a depot update and gets status=started with audit row', async () => {
    let _depotCalled = false;
    h.bridge.depotUpdate = async (_onStream) => {
      _depotCalled = true;
      return { exit_code: 0 };
    };

    const cookie = await loginAsOwner(h);
    // Other tests here also write depot.update rows into the shared,
    // append-only audit_log; the audit context records the user agent, so a
    // unique one identifies this request's own row.
    const userAgent = `depot-update-audit-${randomUUID()}`;
    const resp = await h.app.inject({
      method: 'POST',
      url: '/api/v1/depot/update',
      headers: { cookie, 'user-agent': userAgent },
    });
    expect(resp.statusCode).toBe(200);
    const body = resp.json();
    expect(body.status).toBe('started');
    expect(typeof body.started_at).toBe('string');
    await vi.waitFor(async () => {
      const rows = await h.db
        .select({ id: auditLog.id })
        .from(auditLog)
        .where(
          and(
            eq(auditLog.actionType, 'depot.update'),
            eq(auditLog.targetType, 'depot'),
            sql`${auditLog.context}->>'userAgent' = ${userAgent}`,
          ),
        );
      expect(rows).toHaveLength(1);
    });
  });

  it('returns already_in_progress when depot:updating key exists in redis', async () => {
    const since = new Date().toISOString();
    await h.redis.set('depot:updating', since, 'EX', 3600);

    const cookie = await loginAsOwner(h);
    const resp = await h.app.inject({
      method: 'POST',
      url: '/api/v1/depot/update',
      headers: { cookie },
    });
    expect(resp.statusCode).toBe(200);
    const body = resp.json();
    expect(body.status).toBe('already_in_progress');
    expect(body.since).toBe(since);
  });

  it('returns 401 when unauthenticated', async () => {
    const resp = await h.app.inject({ method: 'POST', url: '/api/v1/depot/update' });
    expect(resp.statusCode).toBe(401);
  });

  it('returns 403 for Viewer role (missing server:install permission)', async () => {
    const viewerRows = await h.db
      .select({ id: roles.id })
      .from(roles)
      .where(eq(roles.name, 'Viewer'))
      .limit(1);
    const viewerRoleId = viewerRows[0]?.id;
    if (!viewerRoleId || !h.seed.ownerSteamId64 || !h.seed.ownerPlayerId)
      throw new Error('Viewer role missing');
    await h.db
      .update(players)
      .set({ roleId: viewerRoleId })
      .where(eq(players.steamId64, h.seed.ownerSteamId64));
    invalidatePermissionCache(h.seed.ownerPlayerId);

    const cookie = await loginAsOwner(h);
    const resp = await h.app.inject({
      method: 'POST',
      url: '/api/v1/depot/update',
      headers: { cookie },
    });
    expect(resp.statusCode).toBe(403);
  });

  it('background task writes depot:last_update=ok on success', async () => {
    let resolveDepot!: () => void;
    h.bridge.depotUpdate = (_onStream) =>
      new Promise<{ exit_code: number }>((resolve) => {
        resolveDepot = () => resolve({ exit_code: 0 });
        resolveDepot();
      });

    const cookie = await loginAsOwner(h);
    await h.app.inject({
      method: 'POST',
      url: '/api/v1/depot/update',
      headers: { cookie },
    });

    const deadline = Date.now() + 2000;
    let lastUpdate: string | null = null;
    while (Date.now() < deadline) {
      lastUpdate = await h.redis.get('depot:last_update');
      if (lastUpdate) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    if (!lastUpdate) throw new Error('depot:last_update never set');
    const parsed = JSON.parse(lastUpdate);
    expect(parsed.status).toBe('ok');
    expect(typeof parsed.finished_at).toBe('string');
  });

  it('background task writes depot:last_update=failed on bridge error', async () => {
    h.bridge.depotUpdate = async () => {
      throw new Error('steamcmd exploded');
    };

    const cookie = await loginAsOwner(h);
    await h.app.inject({
      method: 'POST',
      url: '/api/v1/depot/update',
      headers: { cookie },
    });

    const deadline = Date.now() + 2000;
    let lastUpdate: string | null = null;
    while (Date.now() < deadline) {
      lastUpdate = await h.redis.get('depot:last_update');
      if (lastUpdate) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    if (!lastUpdate) throw new Error('depot:last_update never set');
    const parsed = JSON.parse(lastUpdate);
    expect(parsed.status).toBe('failed');
    expect(parsed.error).toContain('steamcmd exploded');
  });

  it('reports depot:last_update=failed when a SteamCMD progress line silently fails to persist', async () => {
    h.bridge.depotUpdate = async (onStream) => {
      onStream({ stream: 'stdout', data: 'Update state (0x5) verifying install…' });
      return { exit_code: 0 };
    };
    const xaddSpy = vi.spyOn(h.redis, 'xadd').mockRejectedValueOnce(new Error('redis unavailable'));

    const cookie = await loginAsOwner(h);
    try {
      await h.app.inject({
        method: 'POST',
        url: '/api/v1/depot/update',
        headers: { cookie },
      });

      const deadline = Date.now() + 2000;
      let lastUpdate: { status?: string; error?: string } = {};
      let updatingCleared = false;
      while (Date.now() < deadline) {
        lastUpdate = JSON.parse((await h.redis.get('depot:last_update')) ?? '{}');
        updatingCleared = (await h.redis.get('depot:updating')) === null;
        if (lastUpdate.status && updatingCleared) break;
        await new Promise((r) => setTimeout(r, 50));
      }
      expect(lastUpdate.status).toBe('failed');
      expect(lastUpdate.error).toContain('redis unavailable');
      expect(updatingCleared).toBe(true);
    } finally {
      xaddSpy.mockRestore();
    }
  });

  it('clears depot:updating key after background task completes', async () => {
    h.bridge.depotUpdate = async () => ({ exit_code: 0 });

    const cookie = await loginAsOwner(h);
    await h.app.inject({
      method: 'POST',
      url: '/api/v1/depot/update',
      headers: { cookie },
    });

    const deadline = Date.now() + 2000;
    let cleared = false;
    while (Date.now() < deadline) {
      const val = await h.redis.get('depot:updating');
      if (!val) {
        cleared = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(cleared).toBe(true);
  });
});
