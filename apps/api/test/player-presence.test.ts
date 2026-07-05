import type { DatabaseClient } from '@squad/db';
import { playerDailyPresence, playerSessions, players, roles, servers } from '@squad/db/schema';
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
const OWNER_STEAM_ID = STEAM_RUN_BASE + 2_000_000n;
let steamCounter = STEAM_RUN_BASE;
function nextSteam(): bigint {
  steamCounter += 1n;
  return steamCounter;
}

async function seedRole(db: DatabaseClient, opts: { panelAccess?: boolean } = {}): Promise<string> {
  const id = uuidv7();
  await db.insert(roles).values({
    id,
    name: `Role-${id.slice(0, 12)}`,
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

async function loginAs(h: IntegrationHarness, playerId: string): Promise<string> {
  invalidatePermissionCache(playerId);
  const { token } = await createSession(h.db, h.redis, {
    playerId,
    ip: null,
    userAgent: 'player-presence-test',
    ttlMs: 21_600_000,
  });
  return `__Host-sid=${token}`;
}

interface PresenceResponse {
  totals: { online_seconds: number; boost_seconds: number; queue_seconds: number };
  bonus: { formula: string; value_seconds: number };
  by_server: Array<{
    server_id: string;
    server_name: string | null;
    server_slug: string | null;
    online_seconds: number;
    boost_seconds: number;
    queue_seconds: number;
    session_count: number;
  }>;
  sessions: Array<{
    id: string;
    server_id: string;
    mode: string;
    connected_at: string;
    disconnected_at: string | null;
  }>;
  week: { from: string; to: string };
}

describeIfDb('player presence API (PRES-4)', () => {
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

  async function presence(playerId: string, end = '2026-07-05'): Promise<PresenceResponse> {
    const res = await h.app.inject({
      method: 'GET',
      url: `/api/v1/players/${playerId}/presence?end=${end}`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    return res.json() as PresenceResponse;
  }

  it('rejects unauthenticated access with 401', async () => {
    const res = await h.app.inject({
      method: 'GET',
      url: `/api/v1/players/${uuidv7()}/presence`,
    });
    expect(res.statusCode).toBe(401);
  });

  it('rejects a player without panel_access with 403', async () => {
    const noAccessRole = await seedRole(h.db, { panelAccess: false });
    const denied = await seedPlayer(h.db, { roleId: noAccessRole });
    const deniedCookie = await loginAs(h, denied);
    const res = await h.app.inject({
      method: 'GET',
      url: `/api/v1/players/${uuidv7()}/presence`,
      headers: { cookie: deniedCookie },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ error: 'forbidden' });
  });

  it('computes totals, the default bonus, per-server breakdown and calendar sessions (AC)', async () => {
    const serverA = await seedServer(h.db, 'PresenceEU');
    const serverB = await seedServer(h.db, 'PresenceUS');
    const player = await seedPlayer(h.db, { name: 'PresencePlayer' });

    await h.db.insert(playerSessions).values([
      {
        playerId: player,
        serverId: serverA,
        mode: 'online',
        connectedAt: new Date('2026-07-03T10:00:00.000Z'),
        disconnectedAt: new Date('2026-07-03T11:00:00.000Z'),
        durationSeconds: 3600,
      },
      {
        playerId: player,
        serverId: serverA,
        mode: 'boost',
        connectedAt: new Date('2026-07-03T12:00:00.000Z'),
        disconnectedAt: new Date('2026-07-03T12:30:00.000Z'),
        durationSeconds: 1800,
      },
      {
        playerId: player,
        serverId: serverB,
        mode: 'online',
        connectedAt: new Date('2026-07-04T09:00:00.000Z'),
        disconnectedAt: new Date('2026-07-04T10:00:00.000Z'),
        durationSeconds: 3600,
      },
    ]);

    await h.db.insert(playerDailyPresence).values([
      {
        playerId: player,
        serverId: serverA,
        day: '2026-07-03',
        onlineSeconds: 3600,
        boostSeconds: 1800,
        queueSeconds: 0,
        sessionCount: 2,
      },
      {
        playerId: player,
        serverId: serverB,
        day: '2026-07-04',
        onlineSeconds: 3600,
        boostSeconds: 0,
        queueSeconds: 0,
        sessionCount: 1,
      },
    ]);

    const body = await presence(player);

    expect(body.totals).toEqual({ online_seconds: 7200, boost_seconds: 1800, queue_seconds: 0 });
    expect(body.bonus.formula).toBe('online + 2×boost');
    expect(body.bonus.value_seconds).toBe(7200 + 2 * 1800);

    const byServer = new Map(body.by_server.map((row) => [row.server_id, row]));
    expect(byServer.get(serverA)).toMatchObject({
      online_seconds: 3600,
      boost_seconds: 1800,
      session_count: 2,
    });
    expect(byServer.get(serverB)).toMatchObject({ online_seconds: 3600, session_count: 1 });

    const modes = body.sessions.map((s) => s.mode).sort();
    expect(modes).toEqual(['boost', 'online', 'online']);
    expect(body.week).toEqual({ from: '2026-06-29', to: '2026-07-05' });
  });

  it('excludes sessions outside the 7-day calendar window (AC)', async () => {
    const server = await seedServer(h.db, 'WindowSrv');
    const player = await seedPlayer(h.db, { name: 'WindowPresence' });

    await h.db.insert(playerSessions).values([
      {
        playerId: player,
        serverId: server,
        mode: 'online',
        connectedAt: new Date('2026-07-03T10:00:00.000Z'),
        disconnectedAt: new Date('2026-07-03T11:00:00.000Z'),
        durationSeconds: 3600,
      },
      {
        playerId: player,
        serverId: server,
        mode: 'online',
        connectedAt: new Date('2026-06-10T10:00:00.000Z'),
        disconnectedAt: new Date('2026-06-10T11:00:00.000Z'),
        durationSeconds: 3600,
      },
    ]);

    const body = await presence(player);
    expect(body.sessions).toHaveLength(1);
    expect(body.sessions[0]?.connected_at).toBe('2026-07-03T10:00:00.000Z');
  });

  it('reports players with an open session via online-status (AC)', async () => {
    const server = await seedServer(h.db, 'OnlineSrv');
    const onlinePlayer = await seedPlayer(h.db, { name: 'OnlineNow' });
    const offlinePlayer = await seedPlayer(h.db, { name: 'OfflineNow' });

    await h.db.insert(playerSessions).values([
      {
        playerId: onlinePlayer,
        serverId: server,
        mode: 'online',
        connectedAt: new Date('2026-07-05T11:00:00.000Z'),
        disconnectedAt: null,
      },
      {
        playerId: offlinePlayer,
        serverId: server,
        mode: 'online',
        connectedAt: new Date('2026-07-05T09:00:00.000Z'),
        disconnectedAt: new Date('2026-07-05T10:00:00.000Z'),
        durationSeconds: 3600,
      },
    ]);

    const res = await h.app.inject({
      method: 'GET',
      url: '/api/v1/players/online-status',
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    const ids = (res.json() as { online_player_ids: string[] }).online_player_ids;
    expect(ids).toContain(onlinePlayer);
    expect(ids).not.toContain(offlinePlayer);
  });

  it('returns empty aggregates for a player with no presence (AC)', async () => {
    const player = await seedPlayer(h.db, { name: 'FreshPresence' });
    const body = await presence(player);
    expect(body.totals).toEqual({ online_seconds: 0, boost_seconds: 0, queue_seconds: 0 });
    expect(body.by_server).toEqual([]);
    expect(body.sessions).toEqual([]);
    expect(body.bonus.value_seconds).toBe(0);
  });
});
