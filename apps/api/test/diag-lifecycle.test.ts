import { serverCredentials, serverSettings, servers } from '@squad/db/schema';
import type { DiagEvent } from '@squad/diag';
import { eq } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { testSteamId } from './helpers/snapshot-restore.js';
import {
  buildIntegrationApp,
  type IntegrationHarness,
  loginAsOwner,
} from './integration/harness.js';

const OWNER_STEAM_ID = testSteamId(920);

async function seedServer(
  h: IntegrationHarness,
  opts: { slug: string; status: 'running' | 'stopped' | 'pending' },
): Promise<string> {
  const id = uuidv7();
  await h.db.insert(servers).values({
    id,
    displayName: `Diag ${opts.slug}`,
    slug: opts.slug,
    status: opts.status,
  });
  await h.db.insert(serverSettings).values({
    serverId: id,
    installPath: `/var/lib/squad-panel/configs/${id}`,
    gamePort: 7787,
    queryPort: 27165,
    beaconPort: 15000,
    rconPort: 21114,
  });
  await h.db.insert(serverCredentials).values({
    serverId: id,
    rconPort: 21114,
    rconPasswordEncrypted: Buffer.alloc(64, 0x01),
  });
  return id;
}

let h: IntegrationHarness;
let captured: DiagEvent[];

beforeEach(async () => {
  h = await buildIntegrationApp({ seedOwner: { steamId64: OWNER_STEAM_ID } });
  captured = [];
  h.app.diag.emit = async (ev) => {
    captured.push(ev);
  };
});

afterEach(async () => {
  await h.cleanup();
});

describe('server lifecycle emits diag events', () => {
  it('POST /servers/:id/start emits server.start.requested then server.start.done', async () => {
    const id = await seedServer(h, { slug: 'diag-start', status: 'stopped' });
    // Force containerInspect to return not_found so the start path takes
    // containerRun rather than the no-op "already running" branch.
    h.bridge.containerInspect = async ({ name }) => ({
      name,
      state: 'not_found',
      running: false,
      pid: 0,
      started_at: '',
      finished_at: '',
      exit_code: 0,
      image: '',
      restart_count: 0,
      labels: {},
    });
    const cookie = await loginAsOwner(h);

    const res = await h.app.inject({
      method: 'POST',
      url: `/api/v1/servers/${id}/start`,
      headers: { cookie },
    });
    expect([200, 202]).toContain(res.statusCode);
    const kinds = captured.map((e) => e.kind);
    expect(kinds).toContain('server.start.requested');
    expect(kinds.some((k) => k === 'server.start.done' || k === 'server.start.failed')).toBe(true);
  });

  it('POST /servers/:id/stop sets the stop:requested redis key + emits stop.requested', async () => {
    const id = await seedServer(h, { slug: 'diag-stop', status: 'running' });
    // Drop credentials so the stop handler skips the 15s graceful RCON pause.
    await h.db.delete(serverCredentials).where(eq(serverCredentials.serverId, id));
    const cookie = await loginAsOwner(h);

    const res = await h.app.inject({
      method: 'POST',
      url: `/api/v1/servers/${id}/stop`,
      headers: { cookie },
    });
    expect([200, 202]).toContain(res.statusCode);

    const ttl = await h.redis.ttl(`stop:requested:${id}`);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(300);

    const kinds = captured.map((e) => e.kind);
    expect(kinds).toContain('server.stop.requested');
    expect(kinds.some((k) => k === 'server.stop.done' || k === 'server.stop.failed')).toBe(true);
  });

  it('DELETE /servers/:id emits server.soft_delete.{requested,done}', async () => {
    const id = await seedServer(h, { slug: 'diag-soft-del', status: 'stopped' });
    h.bridge.files.set(
      `/var/lib/squad-panel/configs/${id}/ServerConfig/Admins.cfg`,
      Buffer.from('Group=SuperAdmin:changemap\n', 'utf-8'),
    );
    const cookie = await loginAsOwner(h);

    const res = await h.app.inject({
      method: 'DELETE',
      url: `/api/v1/servers/${id}`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);

    const kinds = captured.map((e) => e.kind);
    expect(kinds).toContain('server.soft_delete.requested');
    expect(kinds).toContain('server.soft_delete.done');

    const row = await h.db.query.servers.findFirst({ where: eq(servers.id, id) });
    expect(row?.deletedAt).not.toBeNull();
  });

  it('POST /servers/archive/:id/restore emits server.restore.{requested,done}', async () => {
    const archivedId = await seedServer(h, { slug: 'diag-archived', status: 'stopped' });
    await h.db
      .update(servers)
      .set({ deletedAt: new Date(), deletedByPlayerId: h.seed.ownerPlayerId! })
      .where(eq(servers.id, archivedId));

    const cookie = await loginAsOwner(h);
    const res = await h.app.inject({
      method: 'POST',
      url: `/api/v1/servers/archive/${archivedId}/restore`,
      headers: { cookie },
      payload: {
        slug: 'diag-restored',
        display_name: 'Restored',
        game_port: 7800,
        query_port: 27200,
        beacon_port: 15100,
        rcon_port: 21200,
      },
    });
    expect(res.statusCode).toBe(201);

    const kinds = captured.map((e) => e.kind);
    expect(kinds).toContain('server.restore.requested');
    expect(kinds).toContain('server.restore.done');
  });

  it('POST /servers/:id/install emits server.install.{requested,done}', async () => {
    const id = await seedServer(h, { slug: 'diag-install', status: 'pending' });
    // Seed depot files so seedConfigs succeeds
    const depotRoot = '/opt/panel-data/depot';
    process.env.PANEL_DEPOT_HOST_PATH = depotRoot;
    h.bridge.files.set(
      `${depotRoot}/SquadGameServer.sh`,
      Buffer.from('#!/bin/sh\nexec ./SquadGameServer "$@"\n', 'utf-8'),
    );
    const cookie = await loginAsOwner(h);

    const res = await h.app.inject({
      method: 'POST',
      url: `/api/v1/servers/${id}/install`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);

    const deadline = Date.now() + 25_000;
    while (Date.now() < deadline) {
      const lines = h.app.installProgress.snapshot(id);
      if (lines.some((l) => l.step === 'done' || l.step === 'error')) break;
      await new Promise((r) => setTimeout(r, 25));
    }

    const kinds = captured.map((e) => e.kind);
    expect(kinds).toContain('server.install.requested');
    expect(kinds.some((k) => k === 'server.install.done' || k === 'server.install.failed')).toBe(
      true,
    );
    delete process.env.PANEL_DEPOT_HOST_PATH;
  }, 30_000);
});
