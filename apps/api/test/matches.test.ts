import type { DatabaseClient } from '@squad/db';
import { combatEvents, matches, matchPlayers, players, roles, servers } from '@squad/db/schema';
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

// This suite reuses a dedicated pre-migrated `public` schema (reusePublicSchema)
// rather than a throwaway isolated schema, so seeded rows persist between runs.
// Derive per-run-unique Steam IDs to keep repeated runs collision-free.
const STEAM_RUN_BASE = 76561198100000000n + BigInt(Date.now() % 1_000_000_000);
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
  map?: string | null;
  winner?: 'team1' | 'team2' | 'draw' | null;
  isSeed?: boolean;
  durationSeconds?: number | null;
  endedAt?: Date | null;
  team1Tickets?: number | null;
  team2Tickets?: number | null;
}

async function seedMatch(db: DatabaseClient, opts: SeedMatchOpts): Promise<string> {
  const id = uuidv7();
  await db.insert(matches).values({
    id,
    serverId: opts.serverId,
    layer: opts.layer ?? 'Yehorivka_RAAS_v1',
    map: opts.map ?? 'Yehorivka',
    gameMode: 'RAAS',
    winner: opts.winner ?? null,
    isSeed: opts.isSeed ?? false,
    startedAt: opts.startedAt,
    endedAt: opts.endedAt ?? null,
    durationSeconds: opts.durationSeconds ?? null,
    team1Tickets: opts.team1Tickets ?? null,
    team2Tickets: opts.team2Tickets ?? null,
  });
  return id;
}

async function seedMatchPlayer(
  db: DatabaseClient,
  opts: {
    matchId: string;
    playerId: string;
    team?: 1 | 2 | null;
    squadName?: string | null;
    playSeconds?: number;
    leftAt?: Date | null;
    kills?: number | null;
    deaths?: number | null;
    teamkills?: number | null;
    wounds?: number | null;
    revives?: number | null;
  },
): Promise<void> {
  await db.insert(matchPlayers).values({
    matchId: opts.matchId,
    playerId: opts.playerId,
    team: opts.team ?? null,
    squadName: opts.squadName ?? null,
    playSeconds: opts.playSeconds ?? 600,
    joinedAt: new Date('2026-06-01T10:00:00.000Z'),
    leftAt: opts.leftAt ?? null,
    kills: opts.kills ?? null,
    deaths: opts.deaths ?? null,
    teamkills: opts.teamkills ?? null,
    wounds: opts.wounds ?? null,
    revives: opts.revives ?? null,
  });
}

async function seedCombatEvent(
  db: DatabaseClient,
  opts: {
    serverId: string;
    occurredAt: Date;
    eventType?: 'death' | 'wound' | 'revive';
    attackerPlayerId?: string | null;
    victimPlayerId?: string | null;
    weapon?: string | null;
    isTeamkill?: boolean;
  },
): Promise<void> {
  await db.insert(combatEvents).values({
    serverId: opts.serverId,
    occurredAt: opts.occurredAt,
    eventType: opts.eventType ?? 'death',
    attackerPlayerId: opts.attackerPlayerId ?? null,
    victimPlayerId: opts.victimPlayerId ?? null,
    weapon: opts.weapon ?? null,
    isTeamkill: opts.isTeamkill ?? false,
  });
}

async function loginAs(h: IntegrationHarness, playerId: string): Promise<string> {
  invalidatePermissionCache(playerId);
  const { token } = await createSession(h.db, h.redis, {
    playerId,
    ip: null,
    userAgent: 'matches-test',
    ttlMs: 21_600_000,
  });
  return `__Host-sid=${token}`;
}

interface MatchDto {
  id: string;
  server_id: string;
  server_name: string | null;
  layer: string | null;
  winner: string | null;
  is_seed: boolean;
  started_at: string;
  team1_tickets: number | null;
  duration_seconds: number | null;
}

interface ListResponse {
  items: MatchDto[];
  next_cursor: string | null;
  limit: number;
}

describeIfDb('matches API (MATCH-4)', () => {
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

  async function listMatches(qs: string): Promise<ListResponse> {
    const res = await h.app.inject({
      method: 'GET',
      url: `/api/v1/matches${qs}`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    return res.json() as ListResponse;
  }

  async function paginateAll(qsBase: string, limit: number): Promise<string[]> {
    const collected: string[] = [];
    let cursor: string | null = null;
    for (let guard = 0; guard < 100; guard += 1) {
      const cursorParam = cursor ? `&cursor=${encodeURIComponent(cursor)}` : '';
      const page = await listMatches(`${qsBase}&limit=${limit}${cursorParam}`);
      collected.push(...page.items.map((m) => m.id));
      if (!page.next_cursor) break;
      cursor = page.next_cursor;
    }
    return collected;
  }

  it('rejects unauthenticated access with 401', async () => {
    for (const url of [
      '/api/v1/matches',
      '/api/v1/matches/count',
      '/api/v1/matches/export?format=csv',
    ]) {
      const res = await h.app.inject({ method: 'GET', url });
      expect(res.statusCode).toBe(401);
    }
    const card = await h.app.inject({ method: 'GET', url: `/api/v1/matches/${uuidv7()}` });
    expect(card.statusCode).toBe(401);
  });

  it('rejects players without panel_access with 403 (AC)', async () => {
    const noAccessRole = await seedRole(h.db, { panelAccess: false });
    const player = await seedPlayer(h.db, { roleId: noAccessRole });
    const deniedCookie = await loginAs(h, player);
    for (const url of [
      '/api/v1/matches',
      '/api/v1/matches/count',
      '/api/v1/matches/export?format=csv',
      `/api/v1/matches/${uuidv7()}`,
    ]) {
      const res = await h.app.inject({ method: 'GET', url, headers: { cookie: deniedCookie } });
      expect(res.statusCode).toBe(403);
      expect(res.json()).toMatchObject({ error: 'forbidden' });
    }
  });

  it('grants access to a player with panel_access', async () => {
    const role = await seedRole(h.db, { panelAccess: true });
    const player = await seedPlayer(h.db, { roleId: role });
    const okCookie = await loginAs(h, player);
    const res = await h.app.inject({
      method: 'GET',
      url: '/api/v1/matches',
      headers: { cookie: okCookie },
    });
    expect(res.statusCode).toBe(200);
  });

  it('filters by serverIds', async () => {
    const local = await seedServer(h.db, 'SrvFilter');
    await seedMatch(h.db, {
      serverId: local,
      startedAt: new Date('2026-05-01T10:00:00.000Z'),
      layer: 'SrvFilterLayer',
    });
    const res = await listMatches(`?serverIds=${local}`);
    expect(res.items.length).toBe(1);
    expect(res.items.every((m) => m.server_id === local)).toBe(true);
    expect(res.items[0]?.server_name).toBe('SrvFilter');
  });

  it('filters by layer substring (case-insensitive, parameterized)', async () => {
    const srv = await seedServer(h.db, 'LayerSrv');
    await seedMatch(h.db, {
      serverId: srv,
      startedAt: new Date('2026-05-02T10:00:00.000Z'),
      layer: 'Narva_Invasion_v2',
    });
    await seedMatch(h.db, {
      serverId: srv,
      startedAt: new Date('2026-05-02T11:00:00.000Z'),
      layer: 'Gorodok_RAAS_v1',
    });
    const res = await listMatches(`?serverIds=${srv}&layer=narva`);
    expect(res.items.length).toBe(1);
    expect(res.items[0]?.layer).toBe('Narva_Invasion_v2');
  });

  it('treats layer wildcards literally (no LIKE injection)', async () => {
    const srv = await seedServer(h.db, 'WildcardSrv');
    await seedMatch(h.db, {
      serverId: srv,
      startedAt: new Date('2026-05-02T12:00:00.000Z'),
      layer: 'Fool_RAAS',
    });
    const res = await listMatches(`?serverIds=${srv}&layer=${encodeURIComponent('F_ol')}`);
    expect(res.items.length).toBe(0);
  });

  it('hideSeeding default hides is_seed matches; false shows them (AC)', async () => {
    const srv = await seedServer(h.db, 'SeedSrv');
    await seedMatch(h.db, {
      serverId: srv,
      startedAt: new Date('2026-05-03T10:00:00.000Z'),
      isSeed: false,
    });
    await seedMatch(h.db, {
      serverId: srv,
      startedAt: new Date('2026-05-03T11:00:00.000Z'),
      isSeed: true,
    });

    const hidden = await listMatches(`?serverIds=${srv}`);
    expect(hidden.items.length).toBe(1);
    expect(hidden.items.every((m) => m.is_seed === false)).toBe(true);

    const shown = await listMatches(`?serverIds=${srv}&hideSeeding=false`);
    expect(shown.items.length).toBe(2);
    expect(shown.items.some((m) => m.is_seed === true)).toBe(true);
  });

  it('filters by winner including null', async () => {
    const srv = await seedServer(h.db, 'WinnerSrv');
    await seedMatch(h.db, {
      serverId: srv,
      startedAt: new Date('2026-05-04T10:00:00.000Z'),
      winner: 'team1',
    });
    await seedMatch(h.db, {
      serverId: srv,
      startedAt: new Date('2026-05-04T11:00:00.000Z'),
      winner: 'draw',
    });
    await seedMatch(h.db, {
      serverId: srv,
      startedAt: new Date('2026-05-04T12:00:00.000Z'),
      winner: null,
    });

    const team1 = await listMatches(`?serverIds=${srv}&winner=team1`);
    expect(team1.items.map((m) => m.winner)).toEqual(['team1']);

    const ongoing = await listMatches(`?serverIds=${srv}&winner=null`);
    expect(ongoing.items.map((m) => m.winner)).toEqual([null]);
  });

  it('filters by dateFrom/dateTo on started_at', async () => {
    const srv = await seedServer(h.db, 'DateSrv');
    await seedMatch(h.db, { serverId: srv, startedAt: new Date('2026-01-10T00:00:00.000Z') });
    await seedMatch(h.db, { serverId: srv, startedAt: new Date('2026-02-10T00:00:00.000Z') });
    await seedMatch(h.db, { serverId: srv, startedAt: new Date('2026-03-10T00:00:00.000Z') });

    const res = await listMatches(
      `?serverIds=${srv}&dateFrom=2026-02-01T00:00:00.000Z&dateTo=2026-02-28T00:00:00.000Z`,
    );
    expect(res.items.length).toBe(1);
    expect(res.items[0]?.started_at).toBe('2026-02-10T00:00:00.000Z');
  });

  it('playerId filter returns only matches from the player roster (AC)', async () => {
    const srv = await seedServer(h.db, 'PlayerSrv');
    const target = await seedPlayer(h.db, { name: 'TargetPlayer' });
    const other = await seedPlayer(h.db, { name: 'OtherPlayer' });
    const m1 = await seedMatch(h.db, {
      serverId: srv,
      startedAt: new Date('2026-04-01T10:00:00.000Z'),
    });
    const m2 = await seedMatch(h.db, {
      serverId: srv,
      startedAt: new Date('2026-04-01T11:00:00.000Z'),
    });
    const m3 = await seedMatch(h.db, {
      serverId: srv,
      startedAt: new Date('2026-04-01T12:00:00.000Z'),
    });
    await seedMatchPlayer(h.db, { matchId: m1, playerId: target, team: 1 });
    await seedMatchPlayer(h.db, { matchId: m2, playerId: target, team: 2 });
    await seedMatchPlayer(h.db, { matchId: m3, playerId: other, team: 1 });

    const res = await listMatches(`?serverIds=${srv}&playerId=${target}`);
    const ids = res.items.map((m) => m.id).sort();
    expect(ids).toEqual([m1, m2].sort());
    expect(ids).not.toContain(m3);
  });

  it('count and rows are consistent for identical filters (AC)', async () => {
    const srv = await seedServer(h.db, 'CountSrv');
    for (let i = 0; i < 7; i += 1) {
      await seedMatch(h.db, {
        serverId: srv,
        startedAt: new Date(2026, 5, 1, 8, i, 0),
        winner: i % 2 === 0 ? 'team1' : 'team2',
      });
    }
    const filter = `?serverIds=${srv}&winner=team1`;
    const list = await listMatches(`${filter}&limit=100`);
    const countRes = await h.app.inject({
      method: 'GET',
      url: `/api/v1/matches/count${filter}`,
      headers: { cookie },
    });
    expect(countRes.statusCode).toBe(200);
    const total = (countRes.json() as { total: number }).total;
    expect(typeof total).toBe('number');
    expect(total).toBe(list.items.length);
    expect(total).toBe(4);
  });

  it('returns numbers as numbers, not strings', async () => {
    const srv = await seedServer(h.db, 'NumSrv');
    await seedMatch(h.db, {
      serverId: srv,
      startedAt: new Date('2026-05-20T10:00:00.000Z'),
      durationSeconds: 1834,
      team1Tickets: 250,
      team2Tickets: 0,
    });
    const res = await listMatches(`?serverIds=${srv}`);
    const match = res.items[0];
    expect(match?.duration_seconds).toBe(1834);
    expect(typeof match?.duration_seconds).toBe('number');
    expect(typeof match?.team1_tickets).toBe('number');
  });

  it('match card returns roster with current nickname + team aggregates (AC)', async () => {
    const srv = await seedServer(h.db, 'CardSrv');
    const previousMatchId = await seedMatch(h.db, {
      serverId: srv,
      startedAt: new Date('2026-05-21T09:00:00.000Z'),
      layer: 'PreviousLayer',
    });
    const matchId = await seedMatch(h.db, {
      serverId: srv,
      startedAt: new Date('2026-05-21T10:00:00.000Z'),
      durationSeconds: 3600,
      winner: 'team1',
    });
    const nextMatchId = await seedMatch(h.db, {
      serverId: srv,
      startedAt: new Date('2026-05-21T11:00:00.000Z'),
      layer: 'NextLayer',
    });
    const alice = await seedPlayer(h.db, { name: 'AliceRoster' });
    const bob = await seedPlayer(h.db, { name: 'BobRoster' });
    const carol = await seedPlayer(h.db, { name: 'CarolRoster' });
    await seedMatchPlayer(h.db, {
      matchId,
      playerId: alice,
      team: 1,
      squadName: 'Alpha',
      playSeconds: 3000,
      kills: 7,
      deaths: 2,
      teamkills: 1,
      wounds: 4,
      revives: 3,
    });
    await seedMatchPlayer(h.db, {
      matchId,
      playerId: bob,
      team: 1,
      squadName: 'Alpha',
      playSeconds: 1500,
      kills: 0,
      deaths: 1,
      teamkills: 0,
      wounds: 2,
      revives: 0,
    });
    await seedMatchPlayer(h.db, {
      matchId,
      playerId: carol,
      team: 2,
      squadName: 'Bravo',
      playSeconds: 2400,
    });
    await seedCombatEvent(h.db, {
      serverId: srv,
      occurredAt: new Date('2026-05-21T10:10:00.000Z'),
      attackerPlayerId: alice,
      victimPlayerId: carol,
      weapon: 'BP_AK74',
      isTeamkill: true,
    });
    await seedCombatEvent(h.db, {
      serverId: srv,
      occurredAt: new Date('2026-05-21T09:59:59.000Z'),
      attackerPlayerId: carol,
      victimPlayerId: alice,
      weapon: 'OutsideWindow',
    });

    const res = await h.app.inject({
      method: 'GET',
      url: `/api/v1/matches/${matchId}`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      id: string;
      winner: string;
      roster: Array<{
        player_id: string;
        nickname: string;
        team: number | null;
        squad_name: string | null;
        play_seconds: number;
        left_at: string | null;
        left_early: boolean;
        kills: number | null;
        deaths: number | null;
        teamkills: number | null;
        wounds: number | null;
        revives: number | null;
      }>;
      teams: {
        team1: {
          players: number;
          play_seconds: number;
          kills: number | null;
          deaths: number | null;
          teamkills: number | null;
          wounds: number | null;
          revives: number | null;
        };
        team2: { players: number; play_seconds: number; kills: number | null };
      };
      previous_match: { id: string; layer: string | null } | null;
      next_match: { id: string; layer: string | null } | null;
      combat_events: Array<{
        event_type: string;
        occurred_at: string;
        weapon: string | null;
        is_teamkill: boolean;
        attacker: { player_id: string; current_name: string | null } | null;
        victim: { player_id: string; current_name: string | null } | null;
      }> | null;
    };
    expect(body.id).toBe(matchId);
    expect(body.roster.length).toBe(3);
    const aliceEntry = body.roster.find((r) => r.player_id === alice);
    expect(aliceEntry?.nickname).toBe('AliceRoster');
    expect(aliceEntry?.play_seconds).toBe(3000);
    expect(aliceEntry?.kills).toBe(7);
    expect(aliceEntry?.deaths).toBe(2);
    expect(aliceEntry?.teamkills).toBe(1);
    expect(aliceEntry?.wounds).toBe(4);
    expect(aliceEntry?.revives).toBe(3);
    expect(aliceEntry?.left_at).toBeNull();
    expect(aliceEntry?.left_early).toBe(false);
    expect(body.teams.team1.players).toBe(2);
    expect(body.teams.team1.play_seconds).toBe(4500);
    expect(body.teams.team1.kills).toBe(7);
    expect(body.teams.team1.deaths).toBe(3);
    expect(body.teams.team1.teamkills).toBe(1);
    expect(body.teams.team1.wounds).toBe(6);
    expect(body.teams.team1.revives).toBe(3);
    expect(body.teams.team2.players).toBe(1);
    expect(body.teams.team2.play_seconds).toBe(2400);
    expect(body.teams.team2.kills).toBeNull();
    expect(body.previous_match).toMatchObject({ id: previousMatchId, layer: 'PreviousLayer' });
    expect(body.next_match).toMatchObject({ id: nextMatchId, layer: 'NextLayer' });
    expect(body.combat_events).not.toBeNull();
    expect(body.combat_events?.length).toBe(1);
    expect(body.combat_events?.[0]).toMatchObject({
      event_type: 'death',
      occurred_at: '2026-05-21T10:10:00.000Z',
      weapon: 'BP_AK74',
      is_teamkill: true,
      attacker: { player_id: alice, current_name: 'AliceRoster' },
      victim: { player_id: carol, current_name: 'CarolRoster' },
    });
  });

  it('match card flags roster entries who left well before the match ended as left_early (AC)', async () => {
    const srv = await seedServer(h.db, 'LeftEarlySrv');
    const startedAt = new Date('2026-05-22T10:00:00.000Z');
    const endedAt = new Date('2026-05-22T11:00:00.000Z');
    const matchId = await seedMatch(h.db, { serverId: srv, startedAt, endedAt });
    const earlyLeaver = await seedPlayer(h.db, { name: 'EarlyLeaverRoster' });
    const staffedToEnd = await seedPlayer(h.db, { name: 'StayedToEndRoster' });
    const neverDisconnected = await seedPlayer(h.db, { name: 'NeverDisconnectedRoster' });
    await seedMatchPlayer(h.db, {
      matchId,
      playerId: earlyLeaver,
      team: 1,
      playSeconds: 600,
      // Left 10 minutes before the match ended — well outside the tolerance window.
      leftAt: new Date('2026-05-22T10:50:00.000Z'),
    });
    await seedMatchPlayer(h.db, {
      matchId,
      playerId: staffedToEnd,
      team: 1,
      playSeconds: 3600,
      // Disconnect logged a few seconds before the round-end line: within tolerance.
      leftAt: new Date('2026-05-22T10:59:45.000Z'),
    });
    await seedMatchPlayer(h.db, {
      matchId,
      playerId: neverDisconnected,
      team: 1,
      playSeconds: 3600,
      leftAt: null,
    });

    const res = await h.app.inject({
      method: 'GET',
      url: `/api/v1/matches/${matchId}`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      roster: Array<{ player_id: string; left_at: string | null; left_early: boolean }>;
    };
    const earlyEntry = body.roster.find((r) => r.player_id === earlyLeaver);
    const stayedEntry = body.roster.find((r) => r.player_id === staffedToEnd);
    const neverEntry = body.roster.find((r) => r.player_id === neverDisconnected);

    expect(earlyEntry?.left_at).toBe('2026-05-22T10:50:00.000Z');
    expect(earlyEntry?.left_early).toBe(true);
    expect(stayedEntry?.left_at).toBe('2026-05-22T10:59:45.000Z');
    expect(stayedEntry?.left_early).toBe(false);
    expect(neverEntry?.left_at).toBeNull();
    expect(neverEntry?.left_early).toBe(false);
  });

  it('match card flags a left_at on an open match (ended_at null) as left_early (AC)', async () => {
    const srv = await seedServer(h.db, 'OpenLeftEarlySrv');
    const matchId = await seedMatch(h.db, {
      serverId: srv,
      startedAt: new Date('2026-05-23T10:00:00.000Z'),
      // endedAt intentionally omitted: this is still an open match.
    });
    const disconnected = await seedPlayer(h.db, { name: 'OpenDisconnectedRoster' });
    const stillConnected = await seedPlayer(h.db, { name: 'OpenStillConnectedRoster' });
    await seedMatchPlayer(h.db, {
      matchId,
      playerId: disconnected,
      team: 1,
      playSeconds: 300,
      leftAt: new Date('2026-05-23T10:05:00.000Z'),
    });
    await seedMatchPlayer(h.db, {
      matchId,
      playerId: stillConnected,
      team: 1,
      playSeconds: 900,
      leftAt: null,
    });

    const res = await h.app.inject({
      method: 'GET',
      url: `/api/v1/matches/${matchId}`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      ended_at: string | null;
      roster: Array<{ player_id: string; left_early: boolean }>;
    };
    expect(body.ended_at).toBeNull();
    expect(body.roster.find((r) => r.player_id === disconnected)?.left_early).toBe(true);
    expect(body.roster.find((r) => r.player_id === stillConnected)?.left_early).toBe(false);
  });

  it('match card 404 for unknown id', async () => {
    const res = await h.app.inject({
      method: 'GET',
      url: `/api/v1/matches/${uuidv7()}`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: 'match_not_found' });
  });

  it('CSV export parses with header and correct ISO dates (AC)', async () => {
    const srv = await seedServer(h.db, 'CsvSrv');
    const startedAt = new Date('2026-05-22T14:30:00.000Z');
    await seedMatch(h.db, {
      serverId: srv,
      startedAt,
      layer: 'Mutaha_AAS_v1',
      winner: 'team2',
      durationSeconds: 900,
    });

    const res = await h.app.inject({
      method: 'GET',
      url: `/api/v1/matches/export?serverIds=${srv}&format=csv`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.headers['content-disposition']).toContain('attachment');
    expect(res.headers['content-disposition']).toContain('.csv');

    const lines = res.body.split('\r\n').filter((line) => line.length > 0);
    expect(lines[0]).toBe(
      'id,server_id,server_name,layer,map,game_mode,team1_faction,team2_faction,team1_tickets,team2_tickets,winner,is_seed,started_at,ended_at,duration_seconds,end_reason',
    );
    expect(lines.length).toBe(2);
    const cells = lines[1]?.split(',') ?? [];
    const startedAtIdx = 12;
    expect(cells[startedAtIdx]).toBe(startedAt.toISOString());
    expect(cells).toContain('Mutaha_AAS_v1');
    expect(cells).toContain('900');
  });

  it('default sort (started_at desc): no lost/dup rows across pages, correct order (AC)', async () => {
    const srvX = await seedServer(h.db, 'PageX');
    const srvY = await seedServer(h.db, 'PageY');
    const expected: string[] = [];
    for (let i = 0; i < 12; i += 1) {
      const ts = new Date(2026, 6, 1, 8, i, 0);
      expected.push(await seedMatch(h.db, { serverId: srvX, startedAt: ts }));
      expected.push(await seedMatch(h.db, { serverId: srvY, startedAt: ts }));
    }

    const qsBase = `?serverIds=${srvX}&serverIds=${srvY}`;
    const paged = await paginateAll(qsBase, 5);
    expect(paged.length).toBe(expected.length);
    expect(new Set(paged).size).toBe(expected.length);
    expect([...paged].sort()).toEqual([...expected].sort());

    const single = await listMatches(`${qsBase}&limit=100`);
    expect(single.items.map((m) => m.id)).toEqual(paged);
    const times = single.items.map((m) => new Date(m.started_at).getTime());
    for (let i = 1; i < times.length; i += 1) {
      expect(times[i - 1]).toBeGreaterThanOrEqual(times[i] as number);
    }
  });

  it('sort=duration_seconds asc with NULLs: no lost/dup rows, NULLs last (AC)', async () => {
    const srv = await seedServer(h.db, 'PageDur');
    const durations = [300, 300, 900, null, 1200, null, 600, 300, 1500, null];
    const expected: string[] = [];
    for (let i = 0; i < durations.length; i += 1) {
      expected.push(
        await seedMatch(h.db, {
          serverId: srv,
          startedAt: new Date(2026, 7, 1, 9, i, 0),
          durationSeconds: durations[i] ?? null,
        }),
      );
    }

    const qsBase = `?serverIds=${srv}&sort=duration_seconds&order=asc`;
    const paged = await paginateAll(qsBase, 3);
    expect(paged.length).toBe(expected.length);
    expect(new Set(paged).size).toBe(expected.length);
    expect([...paged].sort()).toEqual([...expected].sort());

    const single = await listMatches(`${qsBase}&limit=100`);
    expect(single.items.map((m) => m.id)).toEqual(paged);
    const durs = single.items.map((m) => m.duration_seconds);
    const firstNull = durs.indexOf(null);
    if (firstNull !== -1) {
      expect(durs.slice(firstNull).every((d) => d === null)).toBe(true);
    }
  });

  it('sort=layer desc: no lost/dup rows across pages', async () => {
    const srv = await seedServer(h.db, 'PageLayer');
    const layers = ['Alpha_A', 'Bravo_B', 'Charlie_C', 'Delta_D', 'Echo_E', 'Foxtrot_F'];
    const expected: string[] = [];
    for (let i = 0; i < layers.length; i += 1) {
      expected.push(
        await seedMatch(h.db, {
          serverId: srv,
          startedAt: new Date(2026, 8, 1, 9, i, 0),
          layer: layers[i],
        }),
      );
    }
    const qsBase = `?serverIds=${srv}&sort=layer&order=desc`;
    const paged = await paginateAll(qsBase, 2);
    expect(paged.length).toBe(expected.length);
    expect(new Set(paged).size).toBe(expected.length);
    expect([...paged].sort()).toEqual([...expected].sort());
  });

  it('rejects an invalid cursor with 400', async () => {
    const res = await h.app.inject({
      method: 'GET',
      url: '/api/v1/matches?cursor=not-a-real-cursor',
      headers: { cookie },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: 'invalid_cursor' });
  });

  it('rejects a cursor whose sort does not match the query sort with 400', async () => {
    const srv = await seedServer(h.db, 'CursorMismatch');
    for (let i = 0; i < 3; i += 1) {
      await seedMatch(h.db, { serverId: srv, startedAt: new Date(2026, 9, 1, 9, i, 0) });
    }
    const first = await listMatches(`?serverIds=${srv}&sort=started_at&limit=1`);
    expect(first.next_cursor).toBeTruthy();
    const res = await h.app.inject({
      method: 'GET',
      url: `/api/v1/matches?serverIds=${srv}&sort=layer&cursor=${encodeURIComponent(first.next_cursor as string)}`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(400);
  });
});
