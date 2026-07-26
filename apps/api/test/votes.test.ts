import type { DatabaseClient } from '@squad/db';
import { gameVoteBallots, gameVotes, players, roles, servers } from '@squad/db/schema';
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
  opts: { name?: string; roleId?: string | null; eosOnly?: boolean } = {},
): Promise<string> {
  const id = uuidv7();
  const name = opts.name ?? `Player-${id.slice(0, 8)}`;
  await db.insert(players).values({
    id,
    steamId64: opts.eosOnly ? null : nextSteam(),
    eosId: opts.eosOnly ? `eos-${id}` : null,
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

interface SeedVoteOpts {
  serverId: string;
  startedAt: Date;
  initiatorPlayerId?: string | null;
  voteType?: 'map_skip' | 'map_change' | 'admin';
  result?: 'passed' | 'failed' | 'cancelled' | null;
  mapCurrent?: string | null;
  mapNext?: string | null;
  mapTarget?: string | null;
  votesCollected?: number;
  votesRequired?: number;
  durationSeconds?: number | null;
}

async function seedVote(db: DatabaseClient, opts: SeedVoteOpts): Promise<string> {
  const id = uuidv7();
  const startedAt = opts.startedAt;
  const endedAt = new Date(startedAt.getTime() + (opts.durationSeconds ?? 45) * 1000);
  await db.insert(gameVotes).values({
    id,
    serverId: opts.serverId,
    initiatorPlayerId: opts.initiatorPlayerId ?? null,
    voteType: opts.voteType ?? 'map_skip',
    mapCurrent: opts.mapCurrent ?? 'Yehorivka_RAAS_v1',
    mapNext: opts.mapNext ?? 'Narva_RAAS_v1',
    mapTarget: opts.mapTarget ?? null,
    votesCollected: opts.votesCollected ?? 12,
    votesRequired: opts.votesRequired ?? 20,
    result: opts.result === undefined ? 'passed' : opts.result,
    durationSeconds: opts.durationSeconds ?? 45,
    startedAt,
    endedAt,
  });
  return id;
}

async function seedBallot(
  db: DatabaseClient,
  opts: { voteId: string; playerId: string; choice: 'yes' | 'no'; votedAt: Date },
): Promise<void> {
  await db.insert(gameVoteBallots).values({
    voteId: opts.voteId,
    playerId: opts.playerId,
    choice: opts.choice,
    votedAt: opts.votedAt,
  });
}

async function loginAs(h: IntegrationHarness, playerId: string): Promise<string> {
  invalidatePermissionCache(playerId);
  const { token } = await createSession(h.db, h.redis, {
    playerId,
    ip: null,
    userAgent: 'votes-test',
    ttlMs: 21_600_000,
  });
  return `__Host-sid=${token}`;
}

interface VoteDto {
  id: string;
  server_id: string;
  server_name: string | null;
  initiator_player_id: string | null;
  initiator_nickname: string | null;
  vote_type: string;
  result: string | null;
  map_current: string | null;
  map_next: string | null;
  map_target: string | null;
  votes_collected: number;
  votes_required: number;
  duration_seconds: number | null;
  started_at: string;
  ended_at: string | null;
  ballot_count: number;
}

interface ListResponse {
  items: VoteDto[];
  next_cursor: string | null;
  limit: number;
}

interface DetailResponse extends VoteDto {
  ballots: Array<{ player_id: string; nickname: string; choice: string; voted_at: string }>;
}

describeIfDb('votes API (VOTE-2)', () => {
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

  async function listVotes(qs: string): Promise<ListResponse> {
    const res = await h.app.inject({
      method: 'GET',
      url: `/api/v1/votes${qs}`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    return res.json() as ListResponse;
  }

  async function paginateIds(qsBase: string, limit: number): Promise<string[]> {
    const collected: string[] = [];
    let cursor: string | null = null;
    for (let guard = 0; guard < 100; guard += 1) {
      const cursorParam = cursor ? `&cursor=${encodeURIComponent(cursor)}` : '';
      const page = await listVotes(`${qsBase}&limit=${limit}${cursorParam}`);
      collected.push(...page.items.map((vote) => vote.id));
      if (!page.next_cursor) break;
      cursor = page.next_cursor;
    }
    return collected;
  }

  it('rejects unauthenticated access with 401', async () => {
    for (const url of ['/api/v1/votes', '/api/v1/votes/count', `/api/v1/votes/${uuidv7()}`]) {
      const res = await h.app.inject({ method: 'GET', url });
      expect(res.statusCode).toBe(401);
    }
  });

  it('rejects players without panel_access with 403 (AC)', async () => {
    const noAccessRole = await seedRole(h.db, { panelAccess: false });
    const player = await seedPlayer(h.db, { roleId: noAccessRole });
    const deniedCookie = await loginAs(h, player);
    for (const url of ['/api/v1/votes', '/api/v1/votes/count', `/api/v1/votes/${uuidv7()}`]) {
      const res = await h.app.inject({ method: 'GET', url, headers: { cookie: deniedCookie } });
      expect(res.statusCode).toBe(403);
      expect(res.json()).toMatchObject({ error: 'forbidden' });
    }
  });

  it('combines server, type, result, initiator and date filters (AC)', async () => {
    const server = await seedServer(h.db, 'VoteFilterSrv');
    const otherServer = await seedServer(h.db, 'VoteOtherSrv');
    const rambo = await seedPlayer(h.db, { name: `Rambo-${uuidv7().slice(0, 6)}` });
    const ghost = await seedPlayer(h.db, { name: `Ghost-${uuidv7().slice(0, 6)}` });

    const target = await seedVote(h.db, {
      serverId: server,
      startedAt: new Date('2026-06-10T10:00:00.000Z'),
      initiatorPlayerId: rambo,
      voteType: 'map_skip',
      result: 'passed',
    });
    await seedVote(h.db, {
      serverId: server,
      startedAt: new Date('2026-06-10T11:00:00.000Z'),
      initiatorPlayerId: ghost,
      voteType: 'map_change',
      result: 'failed',
    });
    await seedVote(h.db, {
      serverId: otherServer,
      startedAt: new Date('2026-06-10T10:30:00.000Z'),
      initiatorPlayerId: rambo,
      voteType: 'map_skip',
      result: 'passed',
    });
    await seedVote(h.db, {
      serverId: server,
      startedAt: new Date('2026-01-01T10:00:00.000Z'),
      initiatorPlayerId: rambo,
      voteType: 'map_skip',
      result: 'passed',
    });

    const byServerType = await listVotes(`?serverId=${server}&voteType=map_skip&result=passed`);
    const dateScoped = byServerType.items.filter(
      (vote) => vote.started_at >= '2026-06-01T00:00:00.000Z',
    );
    expect(dateScoped.map((vote) => vote.id)).toEqual([target]);

    const byInitiator = await listVotes(
      `?serverId=${server}&initiatorPlayerId=${rambo}&dateFrom=2026-06-01T00:00:00.000Z&dateTo=2026-06-30T00:00:00.000Z`,
    );
    expect(byInitiator.items.map((vote) => vote.id)).toEqual([target]);
    expect(byInitiator.items[0]?.initiator_nickname).toContain('Rambo');

    const combined = await listVotes(
      `?serverId=${server}&voteType=map_skip&result=passed&initiatorPlayerId=${rambo}&dateFrom=2026-06-01T00:00:00.000Z&dateTo=2026-06-30T00:00:00.000Z`,
    );
    expect(combined.items.map((vote) => vote.id)).toEqual([target]);
  });

  it('searches initiator by nickname, including EOS-only players', async () => {
    const server = await seedServer(h.db, 'VoteNickSrv');
    const uniqueNick = `Xenon-${uuidv7().slice(0, 8)}`;
    const eosPlayer = await seedPlayer(h.db, { name: uniqueNick, eosOnly: true });
    const decoy = await seedPlayer(h.db, { name: `Decoy-${uuidv7().slice(0, 6)}` });

    const wanted = await seedVote(h.db, {
      serverId: server,
      startedAt: new Date('2026-06-11T10:00:00.000Z'),
      initiatorPlayerId: eosPlayer,
    });
    await seedVote(h.db, {
      serverId: server,
      startedAt: new Date('2026-06-11T11:00:00.000Z'),
      initiatorPlayerId: decoy,
    });

    const found = await listVotes(`?serverId=${server}&initiatorQuery=${uniqueNick.slice(0, 6)}`);
    expect(found.items.map((vote) => vote.id)).toEqual([wanted]);
    expect(found.items[0]?.initiator_nickname).toBe(uniqueNick);

    const none = await listVotes(`?serverId=${server}&initiatorQuery=zzz-no-such-nick`);
    expect(none.items).toEqual([]);
  });

  it('sorts by started_at in both directions', async () => {
    const server = await seedServer(h.db, 'VoteSortSrv');
    const early = await seedVote(h.db, {
      serverId: server,
      startedAt: new Date('2026-06-12T08:00:00.000Z'),
    });
    const mid = await seedVote(h.db, {
      serverId: server,
      startedAt: new Date('2026-06-12T09:00:00.000Z'),
    });
    const late = await seedVote(h.db, {
      serverId: server,
      startedAt: new Date('2026-06-12T10:00:00.000Z'),
    });

    const desc = await listVotes(`?serverId=${server}&order=desc`);
    expect(desc.items.map((vote) => vote.id)).toEqual([late, mid, early]);

    const asc = await listVotes(`?serverId=${server}&order=asc`);
    expect(asc.items.map((vote) => vote.id)).toEqual([early, mid, late]);
  });

  it('keyset paginates together with a filter and sort (AC)', async () => {
    const server = await seedServer(h.db, 'VotePageSrv');
    const initiator = await seedPlayer(h.db);
    const ascending: string[] = [];
    for (let index = 0; index < 7; index += 1) {
      const id = await seedVote(h.db, {
        serverId: server,
        startedAt: new Date(`2026-06-13T${String(8 + index).padStart(2, '0')}:00:00.000Z`),
        initiatorPlayerId: initiator,
        voteType: 'map_skip',
      });
      ascending.push(id);
    }
    await seedVote(h.db, {
      serverId: server,
      startedAt: new Date('2026-06-13T20:00:00.000Z'),
      initiatorPlayerId: initiator,
      voteType: 'admin',
    });

    const paged = await paginateIds(`?serverId=${server}&voteType=map_skip&order=asc`, 2);
    expect(paged).toEqual(ascending);
    expect(new Set(paged).size).toBe(ascending.length);
  });

  it('rejects a malformed cursor with 400', async () => {
    const res = await h.app.inject({
      method: 'GET',
      url: '/api/v1/votes?cursor=not-a-real-cursor',
      headers: { cookie },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: 'invalid_cursor' });
  });

  it('counts votes honoring filters', async () => {
    const server = await seedServer(h.db, 'VoteCountSrv');
    const initiator = await seedPlayer(h.db);
    await seedVote(h.db, {
      serverId: server,
      startedAt: new Date('2026-06-14T08:00:00.000Z'),
      initiatorPlayerId: initiator,
      voteType: 'map_skip',
    });
    await seedVote(h.db, {
      serverId: server,
      startedAt: new Date('2026-06-14T09:00:00.000Z'),
      initiatorPlayerId: initiator,
      voteType: 'map_change',
    });

    const res = await h.app.inject({
      method: 'GET',
      url: `/api/v1/votes/count?serverId=${server}&voteType=map_skip`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ total: 1 });
  });

  it('returns the ballots roster joined to players (AC)', async () => {
    const server = await seedServer(h.db, 'VoteDetailSrv');
    const initiator = await seedPlayer(h.db, { name: `Cap-${uuidv7().slice(0, 6)}` });
    const yesVoter = await seedPlayer(h.db, { name: `Yea-${uuidv7().slice(0, 6)}` });
    const eosVoter = await seedPlayer(h.db, { name: `Neo-${uuidv7().slice(0, 6)}`, eosOnly: true });

    const voteId = await seedVote(h.db, {
      serverId: server,
      startedAt: new Date('2026-06-15T10:00:00.000Z'),
      initiatorPlayerId: initiator,
      votesCollected: 2,
      votesRequired: 5,
    });
    await seedBallot(h.db, {
      voteId,
      playerId: yesVoter,
      choice: 'yes',
      votedAt: new Date('2026-06-15T10:00:10.000Z'),
    });
    await seedBallot(h.db, {
      voteId,
      playerId: eosVoter,
      choice: 'no',
      votedAt: new Date('2026-06-15T10:00:20.000Z'),
    });

    const res = await h.app.inject({
      method: 'GET',
      url: `/api/v1/votes/${voteId}`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    const detail = res.json() as DetailResponse;
    expect(detail.id).toBe(voteId);
    expect(detail.ballot_count).toBe(2);
    expect(detail.ballots).toHaveLength(2);
    expect(detail.ballots[0]).toMatchObject({ player_id: yesVoter, choice: 'yes' });
    expect(detail.ballots[1]).toMatchObject({ player_id: eosVoter, choice: 'no' });
    expect(typeof detail.ballots[0]?.nickname).toBe('string');
    expect(typeof detail.votes_collected).toBe('number');
  });

  it('returns 404 for an unknown vote id', async () => {
    const res = await h.app.inject({
      method: 'GET',
      url: `/api/v1/votes/${uuidv7()}`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: 'vote_not_found' });
  });
});
