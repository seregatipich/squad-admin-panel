import { players, roles, servers } from '@squad/db/schema';
import { eq } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { invalidatePermissionCache } from '../src/lib/rbac.js';
import {
  assertAuditRow,
  buildIntegrationApp,
  type IntegrationHarness,
  loginAsOwner,
  makeFakeBridge,
} from './integration/harness.js';

const OWNER_STEAM_ID = 76561198000002001n;

async function seedServer(h: IntegrationHarness, status: string) {
  const id = uuidv7();
  await h.db.insert(servers).values({
    id,
    displayName: `Server ${id.slice(0, 4)}`,
    slug: `s-${id}`,
    status,
    runtime: 'container',
  });
  return id;
}

let h: IntegrationHarness;

beforeEach(async () => {
  h = await buildIntegrationApp({
    seedOwner: { steamId64: OWNER_STEAM_ID },
    seedOwnerGuard: true,
    bridge: makeFakeBridge(),
  });
  await h.redis.del('depot:updating', 'depot:last_update', 'depot:progress');
});

afterEach(async () => {
  if (h.seed.ownerSteamId64 && h.seed.ownerPlayerId)
    invalidatePermissionCache(h.seed.ownerPlayerId);
  await h.redis.del('depot:updating', 'depot:last_update', 'depot:progress');
  await h.cleanup();
});

describe('POST /api/v1/servers/:id/update', () => {
  it('starts an update for a stopped server, returns started, and audits it', async () => {
    const id = await seedServer(h, 'stopped');
    h.bridge.depotUpdate = async () => ({ exit_code: 0 });

    const cookie = await loginAsOwner(h);
    const resp = await h.app.inject({
      method: 'POST',
      url: `/api/v1/servers/${id}/update`,
      headers: { cookie },
    });
    expect(resp.statusCode).toBe(200);
    const body = resp.json();
    expect(body.status).toBe('started');
    expect(body.server_id).toBe(id);
    await assertAuditRow(h, { action: 'server.game_update', resource: 'server' });
  });

  it('accepts a "ready" server too', async () => {
    const id = await seedServer(h, 'ready');
    h.bridge.depotUpdate = async () => ({ exit_code: 0 });

    const cookie = await loginAsOwner(h);
    const resp = await h.app.inject({
      method: 'POST',
      url: `/api/v1/servers/${id}/update`,
      headers: { cookie },
    });
    expect(resp.statusCode).toBe(200);
  });

  it('returns 404 for an unknown server', async () => {
    const cookie = await loginAsOwner(h);
    const resp = await h.app.inject({
      method: 'POST',
      url: `/api/v1/servers/${uuidv7()}/update`,
      headers: { cookie },
    });
    expect(resp.statusCode).toBe(404);
  });

  it('returns 409 server_must_be_stopped when the server is running', async () => {
    const id = await seedServer(h, 'running');
    const cookie = await loginAsOwner(h);
    const resp = await h.app.inject({
      method: 'POST',
      url: `/api/v1/servers/${id}/update`,
      headers: { cookie },
    });
    expect(resp.statusCode).toBe(409);
    expect(resp.json().error).toBe('server_must_be_stopped');
  });

  it('returns 409 depot_update_in_progress when the depot lock is already held', async () => {
    const id = await seedServer(h, 'stopped');
    await h.redis.set('depot:updating', new Date().toISOString(), 'EX', 3600, 'NX');

    const cookie = await loginAsOwner(h);
    const resp = await h.app.inject({
      method: 'POST',
      url: `/api/v1/servers/${id}/update`,
      headers: { cookie },
    });
    expect(resp.statusCode).toBe(409);
    expect(resp.json().error).toBe('depot_update_in_progress');
  });

  it('returns 401 when unauthenticated', async () => {
    const id = await seedServer(h, 'stopped');
    const resp = await h.app.inject({ method: 'POST', url: `/api/v1/servers/${id}/update` });
    expect(resp.statusCode).toBe(401);
  });

  it('returns 403 for Viewer role (missing server:update permission)', async () => {
    const id = await seedServer(h, 'stopped');
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
      url: `/api/v1/servers/${id}/update`,
      headers: { cookie },
    });
    expect(resp.statusCode).toBe(403);
  });

  describe('background job', () => {
    it('streams SteamCMD output and a done sentinel into depot:progress on success', async () => {
      const id = await seedServer(h, 'stopped');
      h.bridge.depotUpdate = async (onStream) => {
        onStream({ stream: 'stdout', data: 'Update state (0x5) verifying install…' });
        return { exit_code: 0 };
      };

      const cookie = await loginAsOwner(h);
      await h.app.inject({
        method: 'POST',
        url: `/api/v1/servers/${id}/update`,
        headers: { cookie },
      });

      const entries = await waitForStreamEntries(h, 2);
      const lines = entries.map(([, kv]) => entryFields(kv));

      const line = lines.find((f) => f.stream === 'stdout');
      expect(line?.text).toContain('verifying install');

      const done = lines.find((f) => f.stream === 'event');
      expect(done).toBeTruthy();
      expect(JSON.parse(done?.text ?? '{}')).toEqual({ done: true, final: 'done' });

      const lastUpdate = JSON.parse((await h.redis.get('depot:last_update')) ?? '{}');
      expect(lastUpdate.status).toBe('ok');
      expect(await h.redis.get('depot:updating')).toBeNull();
    });

    it('publishes an error done sentinel and depot:last_update=failed on bridge error', async () => {
      const id = await seedServer(h, 'stopped');
      h.bridge.depotUpdate = async () => {
        throw new Error('steamcmd exploded');
      };

      const cookie = await loginAsOwner(h);
      await h.app.inject({
        method: 'POST',
        url: `/api/v1/servers/${id}/update`,
        headers: { cookie },
      });

      const entries = await waitForStreamEntries(h, 1);
      const done = entries.map(([, kv]) => entryFields(kv)).find((f) => f.stream === 'event');
      expect(done).toBeTruthy();
      const parsed = JSON.parse(done?.text ?? '{}');
      expect(parsed).toEqual({ done: true, final: 'error', error: 'steamcmd exploded' });

      const lastUpdate = JSON.parse((await h.redis.get('depot:last_update')) ?? '{}');
      expect(lastUpdate.status).toBe('failed');
      expect(lastUpdate.error).toContain('steamcmd exploded');
      expect(await h.redis.get('depot:updating')).toBeNull();
    });

    it('reports depot:last_update=failed when a progress line silently fails to persist', async () => {
      const id = await seedServer(h, 'stopped');
      h.bridge.depotUpdate = async (onStream) => {
        onStream({ stream: 'stdout', data: 'Update state (0x5) verifying install…' });
        return { exit_code: 0 };
      };
      const xaddSpy = vi
        .spyOn(h.redis, 'xadd')
        .mockRejectedValueOnce(new Error('redis unavailable'));

      const cookie = await loginAsOwner(h);
      try {
        await h.app.inject({
          method: 'POST',
          url: `/api/v1/servers/${id}/update`,
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
  });
});

function entryFields(kv: string[]): { stream: string; text: string } {
  const stream = kv[kv.indexOf('stream') + 1] ?? '';
  const text = kv[kv.indexOf('text') + 1] ?? '';
  return { stream, text };
}

async function waitForStreamEntries(
  h: IntegrationHarness,
  minCount: number,
  timeoutMs = 2000,
): Promise<Array<[string, string[]]>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const entries = (await h.redis.xrange('depot:progress', '-', '+')) as Array<[string, string[]]>;
    if (entries.length >= minCount) return entries;
    if (Date.now() > deadline) throw new Error('depot:progress never received expected entries');
    await new Promise((r) => setTimeout(r, 50));
  }
}
