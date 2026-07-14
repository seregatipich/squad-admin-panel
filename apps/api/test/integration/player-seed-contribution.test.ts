import { randomUUID } from 'node:crypto';
import { bonusTransactions, playerDailyPresence, players, roles, servers } from '@squad/db/schema';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { invalidateAllPermissionCaches } from '../../src/lib/rbac.js';
import { createSession } from '../../src/lib/sessions.js';
import { testSteamId } from '../helpers/snapshot-restore.js';
import {
  buildIntegrationApp,
  type IntegrationHarness,
  loginAsOwner,
  makeFakeBridge,
} from './harness.js';

const OWNER_STEAM = testSteamId(830001);
const NO_PANEL_STEAM = testSteamId(830002);

let h: IntegrationHarness;
let ownerCookie: string;
let noPanelCookie: string;
let seededPlayerId: string;
let emptyPlayerId: string;
let serverAId: string;
let serverBId: string;

const describeIfDb = process.env.DATABASE_URL ? describe : describe.skip;

function todayUtc(offsetDays = 0): string {
  const ms = Date.now() + offsetDays * 86_400_000;
  return new Date(ms).toISOString().slice(0, 10);
}

async function loginAsSteam(steamId64: bigint): Promise<string> {
  const [row] = await h.db
    .select({ id: players.id })
    .from(players)
    .where(eq(players.steamId64, steamId64))
    .limit(1);
  if (!row) throw new Error(`No player for steamId64=${steamId64}`);
  invalidateAllPermissionCaches();
  const { token } = await createSession(h.db, h.redis, {
    playerId: row.id,
    ip: null,
    userAgent: 'seed-contribution-test',
    ttlMs: 21_600_000,
  });
  return `__Host-sid=${token}`;
}

async function seedPlayer(steamOffset: number, name: string): Promise<string> {
  const [row] = await h.db
    .insert(players)
    .values({
      steamId64: testSteamId(steamOffset),
      canonicalName: name,
      canonicalNameNormalized: name.toLowerCase(),
    })
    .returning({ id: players.id });
  if (!row) throw new Error(`failed to seed player ${name}`);
  return row.id;
}

beforeAll(async () => {
  h = await buildIntegrationApp({
    seedOwner: { steamId64: OWNER_STEAM, canonicalName: 'SeedContribOwner' },
    bridge: makeFakeBridge(),
  });
  ownerCookie = await loginAsOwner(h);

  const [noPanelQueuePriority] = await h.db
    .select({ id: roles.id })
    .from(roles)
    .where(eq(roles.name, 'QueuePriority'))
    .limit(1);
  await h.db
    .insert(players)
    .values({
      steamId64: NO_PANEL_STEAM,
      canonicalName: 'SeedContribNoPanel',
      canonicalNameNormalized: 'seedcontribnopanel',
      roleId: noPanelQueuePriority?.id ?? null,
    })
    .onConflictDoNothing();
  noPanelCookie = await loginAsSteam(NO_PANEL_STEAM);

  seededPlayerId = await seedPlayer(830010, 'SeedContribPlayer');
  emptyPlayerId = await seedPlayer(830011, 'SeedContribEmptyPlayer');

  const [serverA] = await h.db
    .insert(servers)
    .values({ id: randomUUID(), displayName: 'Seed Server A', slug: 'seed-server-a-830' })
    .returning({ id: servers.id });
  const [serverB] = await h.db
    .insert(servers)
    .values({ id: randomUUID(), displayName: 'Seed Server B', slug: 'seed-server-b-830' })
    .returning({ id: servers.id });
  if (!serverA || !serverB) throw new Error('failed to seed servers');
  serverAId = serverA.id;
  serverBId = serverB.id;

  const day0 = todayUtc(0);
  const day1 = todayUtc(-1);

  await h.db.insert(playerDailyPresence).values([
    {
      playerId: seededPlayerId,
      day: day0,
      serverId: serverAId,
      onlineSeconds: 3600,
      seedSeconds: 1800,
    },
    {
      playerId: seededPlayerId,
      day: day1,
      serverId: serverAId,
      onlineSeconds: 1200,
      seedSeconds: 1200,
    },
    {
      playerId: seededPlayerId,
      day: day0,
      serverId: serverBId,
      onlineSeconds: 600,
      seedSeconds: 600,
    },
  ]);

  await h.db.insert(bonusTransactions).values([
    {
      playerId: seededPlayerId,
      amount: 2,
      type: 'earn_seed',
      referenceType: 'daily_presence',
      referenceId: day0,
    },
    {
      playerId: seededPlayerId,
      amount: 1,
      type: 'earn_seed',
      referenceType: 'daily_presence',
      referenceId: day1,
    },
    // Not earn_seed / not daily_presence — must not be counted as seed points.
    {
      playerId: seededPlayerId,
      amount: 500,
      type: 'earn_online',
      referenceType: 'daily_presence',
      referenceId: day0,
    },
  ]);
}, 120_000);

afterAll(async () => {
  invalidateAllPermissionCaches();
  await h.cleanup();
}, 60_000);

describeIfDb('GET /api/v1/players/:playerId/seed-contribution', () => {
  it('returns the total, per-server breakdown, daily series and bonus points for the default 30-day window', async () => {
    const res = await h.app.inject({
      method: 'GET',
      url: `/api/v1/players/${seededPlayerId}/seed-contribution`,
      headers: { cookie: ownerCookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      window: { from: string; to: string; days: number };
      total_seed_seconds: number;
      by_server: Array<{ server_id: string; server_name: string | null; seed_seconds: number }>;
      series: Array<{ day: string; seed_seconds: number }>;
      bonus: { k_seed: number; earned_points: number };
    };

    expect(body.window.days).toBe(30);
    expect(body.total_seed_seconds).toBe(1800 + 1200 + 600);

    const byServerMap = new Map(body.by_server.map((row) => [row.server_id, row.seed_seconds]));
    expect(byServerMap.get(serverAId)).toBe(3000);
    expect(byServerMap.get(serverBId)).toBe(600);

    const seriesMap = new Map(body.series.map((row) => [row.day, row.seed_seconds]));
    expect(seriesMap.get(todayUtc(0))).toBe(2400);
    expect(seriesMap.get(todayUtc(-1))).toBe(1200);

    expect(body.bonus.k_seed).toBeGreaterThan(0);
    expect(body.bonus.earned_points).toBe(3); // 2 + 1 earn_seed rows, ignores the earn_online row
  });

  it('clamps the window with the days query parameter', async () => {
    const res = await h.app.inject({
      method: 'GET',
      url: `/api/v1/players/${seededPlayerId}/seed-contribution?days=1`,
      headers: { cookie: ownerCookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { window: { days: number }; total_seed_seconds: number };
    expect(body.window.days).toBe(1);
    expect(body.total_seed_seconds).toBe(1800 + 600); // only today's rows
  });

  it('rejects an out-of-range days value with 400', async () => {
    const tooLow = await h.app.inject({
      method: 'GET',
      url: `/api/v1/players/${seededPlayerId}/seed-contribution?days=0`,
      headers: { cookie: ownerCookie },
    });
    expect(tooLow.statusCode).toBe(400);

    const tooHigh = await h.app.inject({
      method: 'GET',
      url: `/api/v1/players/${seededPlayerId}/seed-contribution?days=999`,
      headers: { cookie: ownerCookie },
    });
    expect(tooHigh.statusCode).toBe(400);
  });

  it('returns zeros for a player with no presence rows', async () => {
    const res = await h.app.inject({
      method: 'GET',
      url: `/api/v1/players/${emptyPlayerId}/seed-contribution`,
      headers: { cookie: ownerCookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      total_seed_seconds: number;
      by_server: unknown[];
      series: unknown[];
      bonus: { earned_points: number };
    };
    expect(body.total_seed_seconds).toBe(0);
    expect(body.by_server).toEqual([]);
    expect(body.series).toEqual([]);
    expect(body.bonus.earned_points).toBe(0);
  });

  it('rejects unauthenticated access with 401', async () => {
    const res = await h.app.inject({
      method: 'GET',
      url: `/api/v1/players/${seededPlayerId}/seed-contribution`,
    });
    expect(res.statusCode).toBe(401);
  });

  it('rejects a user without panel_access with 403', async () => {
    const res = await h.app.inject({
      method: 'GET',
      url: `/api/v1/players/${seededPlayerId}/seed-contribution`,
      headers: { cookie: noPanelCookie },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: 'forbidden' });
  });
});
