import { players, roles } from '@squad/db/schema';
import { RNSQUADJS_CUTOVER_SET } from '@squad/shared-config';
import { eq } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { invalidatePermissionCache } from '../../src/lib/rbac.js';
import { sidecarStatusKey } from '../../src/routes/server-rnsquadjs.js';
import { testSteamId } from '../helpers/snapshot-restore.js';
import {
  buildIntegrationApp,
  type IntegrationHarness,
  loginAsOwner,
  makeFakeBridge,
} from './harness.js';

const describeIfDb = process.env.DATABASE_URL ? describe : describe.skip;

const OWNER_STEAM_ID = testSteamId(982000);

const createBody = {
  display_name: 'RNSquadJS Status Server',
  slug: 'rnsquadjs-status-server',
  description: 'integration fixture',
  game_port: 7820,
  query_port: 27200,
  beacon_port: 15030,
  rcon_port: 21150,
  max_players: 80,
  tickrate: 50,
  multihome: '0.0.0.0',
  extra_args: '',
};

let h: IntegrationHarness;
let SERVER_ID: string;
let STATUS_URL: string;

beforeEach(async () => {
  h = await buildIntegrationApp({
    seedOwner: { steamId64: OWNER_STEAM_ID },
    bridge: makeFakeBridge(),
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
  STATUS_URL = `/api/v1/servers/${SERVER_ID}/rnsquadjs`;
});

afterEach(async () => {
  // The cutover set and the status keys are global (not schema-scoped), so this
  // suite must remove its own members/keys from the shared Redis.
  await h.redis.srem(RNSQUADJS_CUTOVER_SET, SERVER_ID).catch(() => undefined);
  await h.redis
    .del(sidecarStatusKey(SERVER_ID, 'production'), sidecarStatusKey(SERVER_ID, 'shadow'))
    .catch(() => undefined);
  if (h.seed.ownerPlayerId) invalidatePermissionCache(h.seed.ownerPlayerId);
  await h.cleanup();
});

/** Repoints the seeded owner at a fresh role without panel access. */
async function asRoleWithoutPanelAccess(): Promise<string> {
  const roleId = uuidv7();
  await h.db.insert(roles).values({
    id: roleId,
    name: `RnsNoPanel-${roleId}`,
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

describeIfDb('GET /api/v1/servers/:id/rnsquadjs', () => {
  it('rejects an unauthenticated request', async () => {
    const resp = await h.app.inject({ method: 'GET', url: STATUS_URL });
    expect(resp.statusCode).toBe(401);
    expect(resp.json()).toEqual({ error: 'unauthenticated' });
  });

  it('403s for a role without server:view', async () => {
    const cookie = await asRoleWithoutPanelAccess();
    const resp = await h.app.inject({ method: 'GET', url: STATUS_URL, headers: { cookie } });
    expect(resp.statusCode).toBe(403);
    expect(resp.json()).toEqual({ error: 'forbidden', required: ['server:view'] });
  });

  it('reports legacy mode with no heartbeat for an untouched server', async () => {
    const cookie = await loginAsOwner(h);
    const resp = await h.app.inject({ method: 'GET', url: STATUS_URL, headers: { cookie } });
    expect(resp.statusCode).toBe(200);
    expect(resp.json()).toEqual({
      server_id: SERVER_ID,
      mode: 'legacy',
      cutover: false,
      status: null,
    });
  });

  it('reports shadow mode from the :shadow heartbeat key', async () => {
    await h.redis.set(
      sidecarStatusKey(SERVER_ID, 'shadow'),
      JSON.stringify({ state: 'connected', lastChange: '2026-07-27T08:15:00.000Z' }),
      'EX',
      300,
    );
    const cookie = await loginAsOwner(h);
    const resp = await h.app.inject({ method: 'GET', url: STATUS_URL, headers: { cookie } });
    expect(resp.statusCode).toBe(200);
    expect(resp.json()).toEqual({
      server_id: SERVER_ID,
      mode: 'shadow',
      cutover: false,
      status: { state: 'connected', last_change: '2026-07-27T08:15:00.000Z' },
    });
  });

  it('reports production mode with the unsuffixed heartbeat once cut over', async () => {
    await h.redis.sadd(RNSQUADJS_CUTOVER_SET, SERVER_ID);
    await h.redis.set(
      sidecarStatusKey(SERVER_ID, 'production'),
      JSON.stringify({ state: 'disconnected', lastChange: '2026-07-27T09:45:00.000Z' }),
      'EX',
      300,
    );
    const cookie = await loginAsOwner(h);
    const resp = await h.app.inject({ method: 'GET', url: STATUS_URL, headers: { cookie } });
    expect(resp.statusCode).toBe(200);
    expect(resp.json()).toEqual({
      server_id: SERVER_ID,
      mode: 'production',
      cutover: true,
      status: { state: 'disconnected', last_change: '2026-07-27T09:45:00.000Z' },
    });
  });

  it('reports cutover=true with status=null when the heartbeat has expired', async () => {
    await h.redis.sadd(RNSQUADJS_CUTOVER_SET, SERVER_ID);
    const cookie = await loginAsOwner(h);
    const resp = await h.app.inject({ method: 'GET', url: STATUS_URL, headers: { cookie } });
    expect(resp.statusCode).toBe(200);
    expect(resp.json()).toEqual({
      server_id: SERVER_ID,
      mode: 'production',
      cutover: true,
      status: null,
    });
  });

  it('404s for an unknown server', async () => {
    const cookie = await loginAsOwner(h);
    const resp = await h.app.inject({
      method: 'GET',
      url: `/api/v1/servers/${uuidv7()}/rnsquadjs`,
      headers: { cookie },
    });
    expect(resp.statusCode).toBe(404);
    expect(resp.json()).toEqual({ error: 'not_found' });
  });

  // The cutover POST shares this URL. A 400 from its body schema proves the
  // POST route is still matched (an unregistered method would 404) without
  // running the handler, whose sidecar config write needs root-owned /run dirs.
  it('does not shadow the cutover POST on the same URL', async () => {
    const cookie = await loginAsOwner(h);
    const resp = await h.app.inject({
      method: 'POST',
      url: STATUS_URL,
      headers: { cookie },
      payload: { mode: 'nonsense' },
    });
    expect(resp.statusCode).toBe(400);
  });
});
