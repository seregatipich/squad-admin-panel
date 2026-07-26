import type { DatabaseClient } from '@squad/db';
import { matches, matchPlayers, players, roles, servers } from '@squad/db/schema';
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

const STEAM_RUN_BASE = 76561198200000000n + BigInt(Date.now() % 1_000_000_000);
const OWNER_STEAM_ID = STEAM_RUN_BASE + 1_000_000n;
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

interface SeedMatchOpts {
  serverId: string;
  startedAt: Date;
  layer?: string | null;
  winner?: 'team1' | 'team2' | 'draw' | null;
  isSeed?: boolean;
  durationSeconds?: number | null;
}

async function seedMatch(db: DatabaseClient, opts: SeedMatchOpts): Promise<string> {
  const id = uuidv7();
  await db.insert(matches).values({
    id,
    serverId: opts.serverId,
    layer: opts.layer ?? 'Yehorivka_RAAS_v1',
    map: 'Yehorivka',
    gameMode: 'RAAS',
    winner: opts.winner ?? null,
    isSeed: opts.isSeed ?? false,
    startedAt: opts.startedAt,
    endedAt: opts.winner ? new Date(opts.startedAt.getTime() + 3_600_000) : null,
    durationSeconds: opts.durationSeconds ?? (opts.winner ? 3600 : null),
  });
  return id;
}

async function seedMatchPlayer(
  db: DatabaseClient,
  opts: { matchId: string; playerId: string; team?: 1 | 2 | null; playSeconds?: number },
): Promise<void> {
  await db.insert(matchPlayers).values({
    matchId: opts.matchId,
    playerId: opts.playerId,
    team: opts.team ?? null,
    playSeconds: opts.playSeconds ?? 600,
    joinedAt: new Date('2026-06-01T10:00:00.000Z'),
  });
}

async function loginAs(h: IntegrationHarness, playerId: string): Promise<string> {
  invalidatePermissionCache(playerId);
  const { token } = await createSession(h.db, h.redis, {
    playerId,
    ip: null,
    userAgent: 'player-matches-test',
    ttlMs: 21_600_000,
  });
  return `__Host-sid=${token}`;
}

interface RecentRow {
  match_id: string;
  server_name: string | null;
  layer: string | null;
  started_at: string;
  team: number | null;
  play_seconds: number;
  winner: string | null;
  outcome: 'win' | 'loss' | 'draw' | null;
}

interface SummaryResponse {
  recent: RecentRow[];
  winrate: {
    wins: number;
    losses: number;
    draws: number;
    decided: number;
    considered: number;
    window: number;
  };
}

describeIfDb('player match summary API (MATCH-7)', () => {
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

  async function summary(playerId: string): Promise<SummaryResponse> {
    const res = await h.app.inject({
      method: 'GET',
      url: `/api/v1/players/${playerId}/match-summary`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    return res.json() as SummaryResponse;
  }

  it('rejects unauthenticated access with 401', async () => {
    const res = await h.app.inject({
      method: 'GET',
      url: `/api/v1/players/${uuidv7()}/match-summary`,
    });
    expect(res.statusCode).toBe(401);
  });

  it('rejects a player without panel_access with 403', async () => {
    const noAccessRole = await seedRole(h.db, { panelAccess: false });
    const denied = await seedPlayer(h.db, { roleId: noAccessRole });
    const deniedCookie = await loginAs(h, denied);
    const res = await h.app.inject({
      method: 'GET',
      url: `/api/v1/players/${uuidv7()}/match-summary`,
      headers: { cookie: deniedCookie },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ error: 'forbidden' });
  });

  it('computes outcome from the player perspective for both teams and draw (AC)', async () => {
    const srv = await seedServer(h.db, 'OutcomeSrv');
    const player = await seedPlayer(h.db, { name: 'OutcomePlayer' });

    const win = await seedMatch(h.db, {
      serverId: srv,
      startedAt: new Date('2026-06-01T10:00:00.000Z'),
      winner: 'team1',
    });
    const loss = await seedMatch(h.db, {
      serverId: srv,
      startedAt: new Date('2026-06-01T11:00:00.000Z'),
      winner: 'team2',
    });
    const drawMatch = await seedMatch(h.db, {
      serverId: srv,
      startedAt: new Date('2026-06-01T12:00:00.000Z'),
      winner: 'draw',
    });
    const winFromTeam2 = await seedMatch(h.db, {
      serverId: srv,
      startedAt: new Date('2026-06-01T13:00:00.000Z'),
      winner: 'team2',
    });
    const ongoing = await seedMatch(h.db, {
      serverId: srv,
      startedAt: new Date('2026-06-01T14:00:00.000Z'),
      winner: null,
    });

    await seedMatchPlayer(h.db, { matchId: win, playerId: player, team: 1, playSeconds: 3000 });
    await seedMatchPlayer(h.db, { matchId: loss, playerId: player, team: 1, playSeconds: 1200 });
    await seedMatchPlayer(h.db, { matchId: drawMatch, playerId: player, team: 2 });
    await seedMatchPlayer(h.db, { matchId: winFromTeam2, playerId: player, team: 2 });
    await seedMatchPlayer(h.db, { matchId: ongoing, playerId: player, team: 1 });

    const body = await summary(player);
    const byId = new Map(body.recent.map((row) => [row.match_id, row]));

    expect(byId.get(win)?.outcome).toBe('win');
    expect(byId.get(loss)?.outcome).toBe('loss');
    expect(byId.get(drawMatch)?.outcome).toBe('draw');
    expect(byId.get(winFromTeam2)?.outcome).toBe('win');
    expect(byId.get(ongoing)?.outcome).toBeNull();

    expect(byId.get(win)?.play_seconds).toBe(3000);
    expect(byId.get(win)?.team).toBe(1);

    expect(body.winrate.wins).toBe(2);
    expect(body.winrate.losses).toBe(1);
    expect(body.winrate.draws).toBe(1);
    expect(body.winrate.decided).toBe(4);
  });

  it('orders recent matches newest-first and caps the list at 10 (AC)', async () => {
    const srv = await seedServer(h.db, 'OrderSrv');
    const player = await seedPlayer(h.db, { name: 'OrderPlayer' });
    const ids: string[] = [];
    for (let i = 0; i < 14; i += 1) {
      const matchId = await seedMatch(h.db, {
        serverId: srv,
        startedAt: new Date(2026, 5, 2, 8, i, 0),
        winner: 'team1',
      });
      await seedMatchPlayer(h.db, { matchId, playerId: player, team: 1 });
      ids.push(matchId);
    }
    const expectedTop10 = ids.slice(-10).reverse();

    const body = await summary(player);
    expect(body.recent.length).toBe(10);
    expect(body.recent.map((row) => row.match_id)).toEqual(expectedTop10);

    const startedTimes = body.recent.map((row) => new Date(row.started_at).getTime());
    for (let i = 1; i < startedTimes.length; i += 1) {
      expect(startedTimes[i - 1]).toBeGreaterThanOrEqual(startedTimes[i] as number);
    }
  });

  it('limits the winrate window to the last 30 matches (AC)', async () => {
    const srv = await seedServer(h.db, 'WindowSrv');
    const player = await seedPlayer(h.db, { name: 'WindowPlayer' });
    for (let i = 0; i < 35; i += 1) {
      const matchId = await seedMatch(h.db, {
        serverId: srv,
        startedAt: new Date(2026, 4, 1, 6, i, 0),
        winner: 'team1',
      });
      await seedMatchPlayer(h.db, { matchId, playerId: player, team: 1 });
    }
    const body = await summary(player);
    expect(body.winrate.considered).toBe(30);
    expect(body.winrate.wins).toBe(30);
    expect(body.winrate.decided).toBe(30);
  });

  it('returns an empty summary for a player with no matches (AC)', async () => {
    const player = await seedPlayer(h.db, { name: 'FreshPlayer' });
    const body = await summary(player);
    expect(body.recent).toEqual([]);
    expect(body.winrate).toMatchObject({
      wins: 0,
      losses: 0,
      draws: 0,
      decided: 0,
      considered: 0,
    });
  });
});
