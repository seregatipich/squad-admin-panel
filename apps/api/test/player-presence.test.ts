import type { DatabaseClient } from '@squad/db';
import { playerDailyPresence, playerSessions, players, roles, servers } from '@squad/db/schema';
import { eq } from 'drizzle-orm';
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
  totals: {
    online_seconds: number;
    boost_seconds: number;
    queue_seconds: number;
    seed_seconds: number;
  };
  bonus: { formula: string; value_seconds: number };
  by_server: Array<{
    server_id: string;
    server_name: string | null;
    server_slug: string | null;
    online_seconds: number;
    boost_seconds: number;
    queue_seconds: number;
    seed_seconds: number;
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

    expect(body.totals).toEqual({
      online_seconds: 7200,
      boost_seconds: 1800,
      queue_seconds: 0,
      seed_seconds: 0,
    });
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

  it('reports time played while the server was seeding instead of dropping it (regression)', async () => {
    // A player who only ever played during seeding has every second in
    // `seed_seconds`; the response used to omit that column, so the presence
    // card read 0 online for someone with hours on the server.
    const server = await seedServer(h.db, 'SeedOnlySrv');
    const player = await seedPlayer(h.db, { name: 'SeedOnlyPresence' });

    await h.db.insert(playerSessions).values({
      playerId: player,
      serverId: server,
      mode: 'seed',
      connectedAt: new Date('2026-07-04T18:00:00.000Z'),
      disconnectedAt: new Date('2026-07-04T20:04:00.000Z'),
      durationSeconds: 7440,
    });
    await h.db.insert(playerDailyPresence).values({
      playerId: player,
      serverId: server,
      day: '2026-07-04',
      onlineSeconds: 0,
      boostSeconds: 0,
      queueSeconds: 0,
      seedSeconds: 7440,
      sessionCount: 1,
    });

    const body = await presence(player);

    expect(body.totals).toEqual({
      online_seconds: 0,
      boost_seconds: 0,
      queue_seconds: 0,
      seed_seconds: 7440,
    });
    expect(body.by_server).toEqual([
      expect.objectContaining({ server_id: server, seed_seconds: 7440, session_count: 1 }),
    ]);
    // Seeding has its own reward track (SEED-2); it must not inflate the online bonus.
    expect(body.bonus.value_seconds).toBe(0);
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
    expect(body.totals).toEqual({
      online_seconds: 0,
      boost_seconds: 0,
      queue_seconds: 0,
      seed_seconds: 0,
    });
    expect(body.by_server).toEqual([]);
    expect(body.sessions).toEqual([]);
    expect(body.bonus.value_seconds).toBe(0);
  });
});

interface DailyPresenceResponse {
  range: number;
  from: string;
  to: string;
  total_time_played_seconds: number;
  live: { online: boolean; since: string | null };
  series: Array<{
    day: string;
    online_seconds: number;
    boost_seconds: number;
    queue_seconds: number;
    seed_seconds: number;
  }>;
}

describeIfDb('player daily presence API (PRES-3)', () => {
  let h: IntegrationHarness;
  let cookie: string;

  beforeAll(async () => {
    h = await buildIntegrationApp({
      seedOwner: { steamId64: OWNER_STEAM_ID + 5_000n },
      bridge: makeFakeBridge(),
      reusePublicSchema: true,
    });
    // biome-ignore lint/style/noNonNullAssertion: seedOwner guarantees ownerPlayerId
    cookie = await loginAs(h, h.seed.ownerPlayerId!);
  });

  afterAll(async () => {
    await h.cleanup();
  });

  async function daily(
    playerId: string,
    range: 30 | 90 | 365 = 30,
    end = '2026-07-05',
  ): Promise<DailyPresenceResponse> {
    const res = await h.app.inject({
      method: 'GET',
      url: `/api/v1/players/${playerId}/presence/daily?range=${range}&end=${end}`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    return res.json() as DailyPresenceResponse;
  }

  it('rejects unauthenticated access with 401', async () => {
    const res = await h.app.inject({
      method: 'GET',
      url: `/api/v1/players/${uuidv7()}/presence/daily`,
    });
    expect(res.statusCode).toBe(401);
  });

  it('rejects a player without panel_access with 403', async () => {
    const noAccessRole = await seedRole(h.db, { panelAccess: false });
    const denied = await seedPlayer(h.db, { roleId: noAccessRole });
    const deniedCookie = await loginAs(h, denied);
    const res = await h.app.inject({
      method: 'GET',
      url: `/api/v1/players/${uuidv7()}/presence/daily`,
      headers: { cookie: deniedCookie },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ error: 'forbidden' });
  });

  it('sums daily hours across servers per day and orders by day (AC)', async () => {
    const serverA = await seedServer(h.db, 'DailyEU');
    const serverB = await seedServer(h.db, 'DailyUS');
    const player = await seedPlayer(h.db, { name: 'DailyPlayer' });

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
        day: '2026-07-03',
        onlineSeconds: 1800,
        boostSeconds: 0,
        queueSeconds: 600,
        seedSeconds: 900,
        sessionCount: 1,
      },
      {
        playerId: player,
        serverId: serverA,
        day: '2026-07-05',
        onlineSeconds: 7200,
        boostSeconds: 0,
        queueSeconds: 0,
        sessionCount: 3,
      },
    ]);

    const body = await daily(player, 30);

    expect(body.range).toBe(30);
    expect(body.to).toBe('2026-07-05');
    expect(body.from).toBe('2026-06-06');
    expect(body.series).toEqual([
      {
        day: '2026-07-03',
        online_seconds: 5400,
        boost_seconds: 1800,
        queue_seconds: 600,
        seed_seconds: 900,
      },
      {
        day: '2026-07-05',
        online_seconds: 7200,
        boost_seconds: 0,
        queue_seconds: 0,
        seed_seconds: 0,
      },
    ]);
  });

  it('honours the range preset window boundaries (AC)', async () => {
    const server = await seedServer(h.db, 'RangeSrv');
    const player = await seedPlayer(h.db, { name: 'RangePlayer' });

    await h.db.insert(playerDailyPresence).values([
      {
        playerId: player,
        serverId: server,
        day: '2026-06-20',
        onlineSeconds: 3600,
        sessionCount: 1,
      },
      {
        playerId: player,
        serverId: server,
        day: '2026-01-10',
        onlineSeconds: 3600,
        sessionCount: 1,
      },
    ]);

    const window30 = await daily(player, 30);
    expect(window30.from).toBe('2026-06-06');
    expect(window30.series.map((row) => row.day)).toEqual(['2026-06-20']);

    const window365 = await daily(player, 365);
    expect(window365.from).toBe('2025-07-06');
    expect(window365.series.map((row) => row.day)).toEqual(['2026-01-10', '2026-06-20']);
  });

  it('surfaces total_time_played_seconds from the players row (AC)', async () => {
    const player = await seedPlayer(h.db, { name: 'PlaytimePlayer' });
    await h.db
      .update(players)
      .set({ totalTimePlayedSeconds: 123_456 })
      .where(eq(players.id, player));

    const body = await daily(player);
    expect(body.total_time_played_seconds).toBe(123_456);
  });

  it('detects an open session as live with its connect time (AC)', async () => {
    const server = await seedServer(h.db, 'LiveSrv');
    const player = await seedPlayer(h.db, { name: 'LivePlayer' });

    await h.db.insert(playerSessions).values([
      {
        playerId: player,
        serverId: server,
        mode: 'online',
        connectedAt: new Date('2026-07-05T11:15:00.000Z'),
        disconnectedAt: null,
      },
    ]);

    const body = await daily(player);
    expect(body.live).toEqual({ online: true, since: '2026-07-05T11:15:00.000Z' });
  });

  it('reports offline when every session is closed (AC)', async () => {
    const server = await seedServer(h.db, 'ClosedSrv');
    const player = await seedPlayer(h.db, { name: 'ClosedPlayer' });

    await h.db.insert(playerSessions).values([
      {
        playerId: player,
        serverId: server,
        mode: 'online',
        connectedAt: new Date('2026-07-05T09:00:00.000Z'),
        disconnectedAt: new Date('2026-07-05T10:00:00.000Z'),
        durationSeconds: 3600,
      },
    ]);

    const body = await daily(player);
    expect(body.live).toEqual({ online: false, since: null });
  });

  it('returns an empty series for a player with no daily aggregates (AC)', async () => {
    const player = await seedPlayer(h.db, { name: 'FreshDaily' });
    const body = await daily(player);
    expect(body.series).toEqual([]);
    expect(body.total_time_played_seconds).toBe(0);
    expect(body.live).toEqual({ online: false, since: null });
  });
});
