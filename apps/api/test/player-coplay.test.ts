import type { DatabaseClient } from '@squad/db';
import { playerCoplay, players, roles, servers } from '@squad/db/schema';
import { v7 as uuidv7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { invalidatePermissionCache } from '../src/lib/rbac.js';
import { createSession } from '../src/lib/sessions.js';
import {
  buildIntegrationApp,
  type IntegrationHarness,
  makeFakeBridge,
} from './integration/harness.js';

const describeIfDb = process.env.DATABASE_URL ? describe : describe.skip;

const STEAM_RUN_BASE = 76561198900000000n + BigInt(Date.now() % 1_000_000_000);
const OWNER_STEAM_ID = STEAM_RUN_BASE + 3_000_000n;
let steamCounter = STEAM_RUN_BASE;
function nextSteam(): bigint {
  steamCounter += 1n;
  return steamCounter;
}

const TODAY = new Date().toISOString().slice(0, 10);

async function seedRole(db: DatabaseClient, opts: { panelAccess?: boolean } = {}): Promise<string> {
  const id = uuidv7();
  await db.insert(roles).values({
    id,
    name: `Role-${id}`,
    color: 'neutral',
    isSystemRole: false,
    panelAccess: opts.panelAccess ?? true,
  });
  return id;
}

async function seedPlayer(
  db: DatabaseClient,
  opts: { name?: string; roleId?: string | null } = {},
): Promise<string> {
  const id = uuidv7();
  const name = opts.name ?? `Player-${id.slice(0, 8)}`;
  await db.insert(players).values({
    id,
    steamId64: nextSteam(),
    canonicalName: name,
    canonicalNameNormalized: name.toLowerCase(),
    roleId: opts.roleId ?? null,
  });
  return id;
}

async function seedServer(db: DatabaseClient, name: string): Promise<string> {
  const id = uuidv7();
  await db.insert(servers).values({
    id,
    displayName: name,
    slug: `${name.toLowerCase().replace(/[^a-z0-9]/g, '-')}-${id}`,
  });
  return id;
}

/** Insert a coplay bucket, normalising to the canonical player_a_id < player_b_id order. */
async function seedCoplay(
  db: DatabaseClient,
  opts: {
    p1: string;
    p2: string;
    serverId: string;
    windowStart?: string;
    overlapSeconds: number;
    sharedSessionCount: number;
  },
): Promise<void> {
  const [a, b] = opts.p1 < opts.p2 ? [opts.p1, opts.p2] : [opts.p2, opts.p1];
  await db.insert(playerCoplay).values({
    playerAId: a,
    playerBId: b,
    serverId: opts.serverId,
    windowStart: opts.windowStart ?? TODAY,
    overlapSeconds: opts.overlapSeconds,
    sharedSessionCount: opts.sharedSessionCount,
  });
}

async function loginAs(h: IntegrationHarness, playerId: string): Promise<string> {
  invalidatePermissionCache(playerId);
  const { token } = await createSession(h.db, h.redis, {
    playerId,
    ip: null,
    userAgent: 'player-coplay-test',
    ttlMs: 21_600_000,
  });
  return `__Host-sid=${token}`;
}

interface CoplayResponse {
  window: { from: string; to: string; days: number };
  thresholds: { min_shared_sessions: number; min_overlap_seconds: number };
  partners: Array<{
    player_id: string;
    player_name: string | null;
    overlap_seconds: number;
    shared_session_count: number;
    by_server: Array<{
      server_id: string;
      server_name: string | null;
      server_slug: string | null;
      overlap_seconds: number;
      shared_session_count: number;
    }>;
  }>;
}

describeIfDb('player coplay API (ALT-3)', () => {
  let h: IntegrationHarness;
  let cookie: string;

  beforeAll(async () => {
    h = await buildIntegrationApp({
      seedOwner: { steamId64: OWNER_STEAM_ID },
      bridge: makeFakeBridge(),
      reusePublicSchema: true,
    });
    // biome-ignore lint/style/noNonNullAssertion: seedOwner guarantees ownerPlayerId
    cookie = await loginAs(h, h.seed.ownerPlayerId!);
  });

  afterAll(async () => {
    await h.cleanup();
  });

  async function coplay(playerId: string, authCookie = cookie): Promise<CoplayResponse> {
    const res = await h.app.inject({
      method: 'GET',
      url: `/api/v1/players/${playerId}/coplay`,
      headers: { cookie: authCookie },
    });
    expect(res.statusCode).toBe(200);
    return res.json() as CoplayResponse;
  }

  it('rejects unauthenticated access with 401', async () => {
    const res = await h.app.inject({
      method: 'GET',
      url: `/api/v1/players/${uuidv7()}/coplay`,
    });
    expect(res.statusCode).toBe(401);
  });

  it('rejects a player without panel_access with 403', async () => {
    const noAccessRole = await seedRole(h.db, { panelAccess: false });
    const denied = await seedPlayer(h.db, { roleId: noAccessRole });
    const deniedCookie = await loginAs(h, denied);
    const res = await h.app.inject({
      method: 'GET',
      url: `/api/v1/players/${uuidv7()}/coplay`,
      headers: { cookie: deniedCookie },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ error: 'forbidden' });
  });

  it('shows a co-play pair to both players with the same overlap (AC)', async () => {
    const server = await seedServer(h.db, 'CoplayEU');
    const alice = await seedPlayer(h.db, { name: 'CoplayAlice' });
    const bob = await seedPlayer(h.db, { name: 'CoplayBob' });

    // 10 shared sessions, 12h overlap -> above the 5-session / 10h defaults.
    await seedCoplay(h.db, {
      p1: alice,
      p2: bob,
      serverId: server,
      overlapSeconds: 43_200,
      sharedSessionCount: 10,
    });

    const fromAlice = await coplay(alice);
    const bobEntry = fromAlice.partners.find((p) => p.player_id === bob);
    expect(bobEntry).toBeDefined();
    expect(bobEntry?.player_name).toBe('CoplayBob');
    expect(bobEntry?.overlap_seconds).toBe(43_200);
    expect(bobEntry?.shared_session_count).toBe(10);
    expect(bobEntry?.by_server).toEqual([
      expect.objectContaining({
        server_id: server,
        overlap_seconds: 43_200,
        shared_session_count: 10,
      }),
    ]);

    const fromBob = await coplay(bob);
    const aliceEntry = fromBob.partners.find((p) => p.player_id === alice);
    expect(aliceEntry?.overlap_seconds).toBe(bobEntry?.overlap_seconds);
    expect(aliceEntry?.shared_session_count).toBe(bobEntry?.shared_session_count);
  });

  it('aggregates one partner across servers into a per-server breakdown', async () => {
    const serverA = await seedServer(h.db, 'CoplayMultiA');
    const serverB = await seedServer(h.db, 'CoplayMultiB');
    const carol = await seedPlayer(h.db, { name: 'CoplayCarol' });
    const dave = await seedPlayer(h.db, { name: 'CoplayDave' });

    await seedCoplay(h.db, {
      p1: carol,
      p2: dave,
      serverId: serverA,
      overlapSeconds: 30_000,
      sharedSessionCount: 4,
    });
    await seedCoplay(h.db, {
      p1: carol,
      p2: dave,
      serverId: serverB,
      overlapSeconds: 20_000,
      sharedSessionCount: 3,
    });

    const body = await coplay(carol);
    const daveEntry = body.partners.find((p) => p.player_id === dave);
    // Totals are the sum across both servers (50_000s / 7 sessions -> above thresholds).
    expect(daveEntry?.overlap_seconds).toBe(50_000);
    expect(daveEntry?.shared_session_count).toBe(7);
    expect(daveEntry?.by_server).toHaveLength(2);
    const serverIds = daveEntry?.by_server.map((s) => s.server_id).sort();
    expect(serverIds).toEqual([serverA, serverB].sort());
  });

  it('omits pairs below either noise-floor threshold', async () => {
    const server = await seedServer(h.db, 'CoplayNoise');
    const eve = await seedPlayer(h.db, { name: 'CoplayEve' });
    const lowSessions = await seedPlayer(h.db, { name: 'CoplayLowSessions' });
    const lowOverlap = await seedPlayer(h.db, { name: 'CoplayLowOverlap' });

    // Below the session floor: only 2 shared sessions despite huge overlap.
    await seedCoplay(h.db, {
      p1: eve,
      p2: lowSessions,
      serverId: server,
      overlapSeconds: 100_000,
      sharedSessionCount: 2,
    });
    // Below the overlap floor: many sessions but only ~1h total.
    await seedCoplay(h.db, {
      p1: eve,
      p2: lowOverlap,
      serverId: server,
      overlapSeconds: 3_600,
      sharedSessionCount: 20,
    });

    const body = await coplay(eve);
    const partnerIds = body.partners.map((p) => p.player_id);
    expect(partnerIds).not.toContain(lowSessions);
    expect(partnerIds).not.toContain(lowOverlap);
  });
});
