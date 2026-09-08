import { auditLog, players, roles } from '@squad/db/schema';
import {
  legacySidecarStatusKey,
  RNSQUADJS_CUTOVER_SET,
  SQUADJS2_ENGINE_SET,
  sidecarStatusKey,
} from '@squad/shared-config';
import { eq } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { invalidatePermissionCache } from '../../src/lib/rbac.js';
import { testSteamId } from '../helpers/snapshot-restore.js';
import {
  buildIntegrationApp,
  type IntegrationHarness,
  loginAsOwner,
  makeFakeBridge,
} from './harness.js';

// Both writers touch /run on the host; the route's launch sequencing, Redis
// state and audit trail are what this suite exercises.
vi.mock('../../src/lib/squadjs2.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/lib/squadjs2.js')>()),
  writeSquadjs2Config: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../src/lib/rnsquadjs.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/lib/rnsquadjs.js')>()),
  writeSidecarConfig: vi.fn().mockResolvedValue(undefined),
}));

const describeIfDb = process.env.DATABASE_URL ? describe : describe.skip;

const OWNER_STEAM_ID = testSteamId(982400);

const createBody = {
  display_name: 'Sidecar Engine Server',
  slug: 'sidecar-engine-server',
  description: 'integration fixture',
  game_port: 7830,
  query_port: 27210,
  beacon_port: 15040,
  rcon_port: 21160,
  max_players: 80,
  tickrate: 50,
  multihome: '0.0.0.0',
  extra_args: '',
};

let h: IntegrationHarness;
let SERVER_ID: string;
let URL: string;
let runCalls: Array<{ engine: string; server_id: string; env: Record<string, string> }>;
let rmCalls: string[];
let deletedDirs: string[];

beforeEach(async () => {
  runCalls = [];
  rmCalls = [];
  deletedDirs = [];
  const bridge = makeFakeBridge();
  bridge.containerRunSquadjs2 = async (p) => {
    runCalls.push({ engine: 'squadjs2', ...p });
    return { container_id: 'fake-squadjs2-id', status: 'started' as const };
  };
  bridge.containerRunRnsquadjs = async (p) => {
    runCalls.push({ engine: 'rnsquadjs', ...p });
    return { container_id: 'fake-rnsquadjs-id', status: 'started' as const };
  };
  bridge.containerRm = async (p) => {
    rmCalls.push(p.name);
    return { status: 'ok' };
  };
  bridge.directoryDelete = async (p) => {
    deletedDirs.push(p.path);
    return { removed: true };
  };
  h = await buildIntegrationApp({
    seedOwner: { steamId64: OWNER_STEAM_ID },
    seedOwnerGuard: true,
    bridge,
  });
  const cookie = await loginAsOwner(h);
  const create = await h.app.inject({
    method: 'POST',
    url: '/api/v1/servers',
    headers: { cookie },
    payload: createBody,
  });
  expect(create.statusCode).toBe(201);
  SERVER_ID = create.json<{ id: string }>().id;
  URL = `/api/v1/servers/${SERVER_ID}/sidecar`;
});

afterEach(async () => {
  // The engine set, cutover set and status keys are global (not schema-scoped),
  // so this suite must remove its own members and keys from the shared Redis.
  await h.redis.srem(RNSQUADJS_CUTOVER_SET, SERVER_ID).catch(() => undefined);
  await h.redis.srem(SQUADJS2_ENGINE_SET, SERVER_ID).catch(() => undefined);
  await h.redis
    .del(
      sidecarStatusKey(SERVER_ID, 'production'),
      sidecarStatusKey(SERVER_ID, 'shadow'),
      legacySidecarStatusKey(SERVER_ID, 'production'),
      legacySidecarStatusKey(SERVER_ID, 'shadow'),
    )
    .catch(() => undefined);
  if (h.seed.ownerPlayerId) invalidatePermissionCache(h.seed.ownerPlayerId);
  await h.cleanup();
});

/** Repoints the seeded owner at a fresh role without panel access. */
async function asRoleWithoutPanelAccess(): Promise<string> {
  const roleId = uuidv7();
  await h.db.insert(roles).values({
    id: roleId,
    name: `SidecarNoPanel-${roleId}`,
    color: 'blue',
    isSystemRole: false,
    panelAccess: false,
  });
  await h.db
    .update(players)
    .set({ roleId })
    // biome-ignore lint/style/noNonNullAssertion: owner steam id seeded above
    .where(eq(players.steamId64, h.seed.ownerSteamId64!));
  // biome-ignore lint/style/noNonNullAssertion: owner player seeded above
  invalidatePermissionCache(h.seed.ownerPlayerId!);
  return loginAsOwner(h);
}

describeIfDb('GET /api/v1/servers/:id/sidecar', () => {
  it('rejects an unauthenticated request', async () => {
    const resp = await h.app.inject({ method: 'GET', url: URL });
    expect(resp.statusCode).toBe(401);
  });

  it('403s for a role without server:view', async () => {
    const cookie = await asRoleWithoutPanelAccess();
    const resp = await h.app.inject({ method: 'GET', url: URL, headers: { cookie } });
    expect(resp.statusCode).toBe(403);
    expect(resp.json()).toEqual({ error: 'forbidden', required: ['server:view'] });
  });

  it('reports the legacy parser and the rnsquadjs engine for an untouched server', async () => {
    const cookie = await loginAsOwner(h);
    const resp = await h.app.inject({ method: 'GET', url: URL, headers: { cookie } });
    expect(resp.statusCode).toBe(200);
    expect(resp.json()).toEqual({
      server_id: SERVER_ID,
      engine: 'rnsquadjs',
      mode: 'legacy',
      cutover: false,
      status: null,
    });
  });

  it('reports a live shadow status written under the engine-neutral key', async () => {
    const cookie = await loginAsOwner(h);
    await h.redis.set(
      sidecarStatusKey(SERVER_ID, 'shadow'),
      JSON.stringify({ state: 'connected', lastChange: '2026-09-08T03:00:00.000Z' }),
      'EX',
      60,
    );

    const resp = await h.app.inject({ method: 'GET', url: URL, headers: { cookie } });

    expect(resp.json()).toMatchObject({
      mode: 'shadow',
      status: { state: 'connected', last_change: '2026-09-08T03:00:00.000Z' },
    });
  });

  it('still reads a sidecar that only writes the legacy RNSquadJS key', async () => {
    const cookie = await loginAsOwner(h);
    await h.redis.set(
      legacySidecarStatusKey(SERVER_ID, 'shadow'),
      JSON.stringify({ state: 'connected', lastChange: '2026-09-08T02:00:00.000Z' }),
      'EX',
      60,
    );

    const resp = await h.app.inject({ method: 'GET', url: URL, headers: { cookie } });

    expect(resp.json()).toMatchObject({
      mode: 'shadow',
      status: { state: 'connected', last_change: '2026-09-08T02:00:00.000Z' },
    });
  });
});

describeIfDb('POST /api/v1/servers/:id/sidecar', () => {
  it('403s for a role without server:stop', async () => {
    const cookie = await asRoleWithoutPanelAccess();
    const resp = await h.app.inject({
      method: 'POST',
      url: URL,
      headers: { cookie },
      payload: { engine: 'squadjs2', mode: 'shadow' },
    });
    expect(resp.statusCode).toBe(403);
  });

  it('switches a server to SquadJS2 in shadow mode and records the engine', async () => {
    const cookie = await loginAsOwner(h);

    const resp = await h.app.inject({
      method: 'POST',
      url: URL,
      headers: { cookie },
      payload: { engine: 'squadjs2', mode: 'shadow' },
    });

    expect(resp.statusCode).toBe(200);
    expect(resp.json()).toMatchObject({ engine: 'squadjs2', mode: 'shadow' });
    expect(await h.redis.sismember(SQUADJS2_ENGINE_SET, SERVER_ID)).toBe(1);
    expect(runCalls).toEqual([
      {
        engine: 'squadjs2',
        server_id: SERVER_ID,
        env: { SERVER_ID, LOG_FILE: '/squad/Logs/SquadGame.log' },
      },
    ]);
  });

  // One writer per stream: the other engine's container must be gone before the
  // new one starts, or `:shadow` gets duplicate events.
  it('stops both engines before starting the target one', async () => {
    const cookie = await loginAsOwner(h);

    await h.app.inject({
      method: 'POST',
      url: URL,
      headers: { cookie },
      payload: { engine: 'squadjs2', mode: 'shadow' },
    });

    expect([...rmCalls].sort()).toEqual([`rnsquadjs-${SERVER_ID}`, `squadjs2-${SERVER_ID}`]);
  });

  it('purges the abandoned engine config dir', async () => {
    const cookie = await loginAsOwner(h);

    await h.app.inject({
      method: 'POST',
      url: URL,
      headers: { cookie },
      payload: { engine: 'squadjs2', mode: 'shadow' },
    });

    expect(deletedDirs).toEqual([`/run/squad-panel/rnsquadjs/${SERVER_ID}`]);
  });

  it('switches back to RNSquadJS and clears the engine set', async () => {
    const cookie = await loginAsOwner(h);
    await h.app.inject({
      method: 'POST',
      url: URL,
      headers: { cookie },
      payload: { engine: 'squadjs2', mode: 'shadow' },
    });

    const resp = await h.app.inject({
      method: 'POST',
      url: URL,
      headers: { cookie },
      payload: { engine: 'rnsquadjs', mode: 'shadow' },
    });

    expect(resp.statusCode).toBe(200);
    expect(await h.redis.sismember(SQUADJS2_ENGINE_SET, SERVER_ID)).toBe(0);
    expect(deletedDirs.at(-1)).toBe(`/run/squad-panel/squadjs2/${SERVER_ID}`);
    expect(runCalls.at(-1)?.engine).toBe('rnsquadjs');
  });

  it('marks the server for cutover and answers 202 for a production switch', async () => {
    const cookie = await loginAsOwner(h);

    const resp = await h.app.inject({
      method: 'POST',
      url: URL,
      headers: { cookie },
      payload: { engine: 'squadjs2', mode: 'production' },
    });

    expect(resp.statusCode).toBe(202);
    expect(resp.json()).toMatchObject({ engine: 'squadjs2', status: 'switching' });
    expect(await h.redis.sismember(RNSQUADJS_CUTOVER_SET, SERVER_ID)).toBe(1);
    // The deferred launch is parked on the reconcile tick and must not have run.
    expect(runCalls).toEqual([]);
    // Undo the desired state before the deferred continuation fires.
    await h.redis.srem(RNSQUADJS_CUTOVER_SET, SERVER_ID);
  });

  it('writes an audit entry for the switch', async () => {
    const cookie = await loginAsOwner(h);
    await h.app.inject({
      method: 'POST',
      url: URL,
      headers: { cookie },
      payload: { engine: 'squadjs2', mode: 'shadow' },
    });

    // The audit entry is written from an onResponse hook, which resolves after
    // inject() returns; poll briefly instead of racing it.
    let rows: Array<{ actionType: string }> = [];
    for (let attempt = 0; attempt < 20 && rows.length === 0; attempt++) {
      rows = await h.db
        .select({ actionType: auditLog.actionType })
        .from(auditLog)
        .where(eq(auditLog.actionType, 'server.sidecar.switch'));
      if (rows.length === 0) await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(rows.length).toBeGreaterThan(0);
  });

  it('404s for an unknown server', async () => {
    const cookie = await loginAsOwner(h);
    const resp = await h.app.inject({
      method: 'POST',
      url: `/api/v1/servers/${uuidv7()}/sidecar`,
      headers: { cookie },
      payload: { engine: 'squadjs2', mode: 'shadow' },
    });
    expect(resp.statusCode).toBe(404);
  });
});
