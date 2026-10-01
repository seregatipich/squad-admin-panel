import { servers } from '@squad/db/schema';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { testSteamId } from './helpers/snapshot-restore.js';
import {
  buildIntegrationApp,
  type IntegrationHarness,
  loginAsOwner,
  makeFakeBridge,
} from './integration/harness.js';

// #20: an install ends with a containerRun that mounts the one shared depot
// volume, exactly like /start. Neither the install request nor the container
// boot at its end may happen while a depot update rewrites that volume.

// The sidecar relaunch writes real files under /run; keep install tests off
// the host's runtime dir (see server-install-configs.test.ts).
vi.mock('../src/lib/rnsquadjs.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/rnsquadjs.js')>()),
  writeSidecarConfig: vi.fn().mockResolvedValue(undefined),
  relaunchSidecar: vi.fn().mockResolvedValue({ containerId: 'rnsquadjs-xyz', mode: 'shadow' }),
}));

const OWNER_STEAM_ID = testSteamId(932);

let h: IntegrationHarness;
let containerRuns: string[];
let nextPortBase = 7800;

async function createServer(cookie: string): Promise<string> {
  const base = nextPortBase;
  nextPortBase += 10;
  const resp = await h.app.inject({
    method: 'POST',
    url: '/api/v1/servers',
    headers: { cookie },
    payload: {
      display_name: `Install lock ${base}`,
      slug: `install-lock-${base}`,
      description: 'depot lock regression fixture',
      game_port: base,
      query_port: base + 20_000,
      beacon_port: base + 8_000,
      rcon_port: base + 14_000,
      max_players: 80,
      tickrate: 50,
      multihome: '0.0.0.0',
      extra_args: '',
    },
  });
  if (resp.statusCode !== 201) throw new Error(`create failed: ${resp.body}`);
  return resp.json<{ id: string }>().id;
}

async function waitForTerminalLine(serverId: string): Promise<{ step: string; message: string }> {
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    const terminal = h.app.installProgress
      .snapshot(serverId)
      .find((l) => l.step === 'done' || l.step === 'error');
    if (terminal) return terminal;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('install did not reach a terminal progress line within 8s');
}

beforeAll(async () => {
  h = await buildIntegrationApp({ seedOwner: { steamId64: OWNER_STEAM_ID } });
});

afterAll(async () => {
  await h?.cleanup();
});

beforeEach(async () => {
  containerRuns = [];
  Object.assign(h.bridge, makeFakeBridge(), {
    containerRun: async ({ server_id }: { server_id: string }) => {
      containerRuns.push(server_id);
      return { container_id: 'fake-container-id', status: 'started' };
    },
  });
  await h.redis.del('depot:updating');
});

describe('POST /api/v1/servers/:id/install during a depot update', () => {
  it('returns 409 depot_update_in_progress and never starts the install', async () => {
    const cookie = await loginAsOwner(h);
    const id = await createServer(cookie);
    const statusBefore = (await h.db.query.servers.findFirst({ where: eq(servers.id, id) }))
      ?.status;
    await h.redis.set('depot:updating', new Date().toISOString(), 'EX', 3600);

    const resp = await h.app.inject({
      method: 'POST',
      url: `/api/v1/servers/${id}/install`,
      headers: { cookie },
    });

    expect(resp.statusCode).toBe(409);
    expect(resp.json().error).toBe('depot_update_in_progress');
    // An install claims the server ('installing') before the route replies, so
    // an unchanged status below proves no background install was spawned.
    expect(containerRuns).toEqual([]);
    const row = await h.db.query.servers.findFirst({ where: eq(servers.id, id) });
    expect(row?.status).toBe(statusBefore);
  });

  it('fails the install instead of booting the container when an update starts mid-install', async () => {
    const cookie = await loginAsOwner(h);
    const id = await createServer(cookie);
    // The firewall step runs after the install passed its request-time check
    // and right before containerRun: a depot update that takes the lock here
    // is the race the pre-boot check closes.
    h.bridge.ufwRule = async () => {
      await h.redis.set('depot:updating', new Date().toISOString(), 'EX', 3600);
      return { output: '', status: 'ok' };
    };

    const resp = await h.app.inject({
      method: 'POST',
      url: `/api/v1/servers/${id}/install`,
      headers: { cookie },
    });
    expect(resp.statusCode).toBe(200);

    const terminal = await waitForTerminalLine(id);
    expect(terminal).toMatchObject({ step: 'error', message: 'depot_update_in_progress' });
    expect(containerRuns).toEqual([]);
    const row = await h.db.query.servers.findFirst({ where: eq(servers.id, id) });
    expect(row?.status).toBe('failed');
  });

  it('boots the container once no depot update holds the lock', async () => {
    const cookie = await loginAsOwner(h);
    const id = await createServer(cookie);

    const resp = await h.app.inject({
      method: 'POST',
      url: `/api/v1/servers/${id}/install`,
      headers: { cookie },
    });
    expect(resp.statusCode).toBe(200);

    await waitForTerminalLine(id);
    expect(containerRuns).toEqual([id]);
  });
});

// Regression (#43 finding 321, install path): the depot-init SteamCMD run's
// non-zero exit code was ignored, so the install booted on a broken depot.
describe('POST /api/v1/servers/:id/install with a failing depot-init run', () => {
  it('fails the install and never boots the container', async () => {
    const cookie = await loginAsOwner(h);
    const id = await createServer(cookie);
    h.bridge.depotUpdate = async () => ({ exit_code: 3 });

    const resp = await h.app.inject({
      method: 'POST',
      url: `/api/v1/servers/${id}/install`,
      headers: { cookie },
    });
    expect(resp.statusCode).toBe(200);

    const terminal = await waitForTerminalLine(id);
    expect(terminal.step).toBe('error');
    expect(terminal.message).toContain('exit code 3');
    expect(containerRuns).toEqual([]);
  });
});
