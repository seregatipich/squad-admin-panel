import {
  createDatabaseClient,
  events,
  matches,
  matchPlayers,
  playerSessions,
  players,
  servers,
} from '@squad/db';
import { and, asc, eq, sql } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { computeOpenMatchRoster, handleMatchClose } from '../src/match-roster/store.js';

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error('DATABASE_URL must point at the match2 test database');

const db = createDatabaseClient(DATABASE_URL);

const SERVER_ID = uuidv7();
const PLAYER_A = uuidv7();
const PLAYER_B = uuidv7();
const PLAYER_C = uuidv7();
const PLAYER_D = uuidv7();

const STEAM_A = 76561198000000001n;
const STEAM_B = 76561198000000002n;
const STEAM_D = 76561198000000004n;
const EOS_A = 'a'.repeat(32);
const EOS_B = 'b'.repeat(32);
const EOS_C = 'c'.repeat(32);
const EOS_D = 'd'.repeat(32);

const START = new Date('2026-07-05T18:00:00.000Z');
const END = new Date(START.getTime() + 3600_000);
const at = (offsetSeconds: number) => new Date(START.getTime() + offsetSeconds * 1000);

const MATCH_ID = uuidv7();

function pollPayload(
  polledAt: Date,
  entries: Array<{ steam: bigint; eos: string; team: number | null; squad: number | null }>,
) {
  return {
    players: entries.map((entry) => ({
      steam_id64: entry.steam.toString(),
      eos_id: entry.eos,
      name: 'player',
      team_id: entry.team,
      squad_id: entry.squad,
      is_leader: false,
    })),
    polled_at: polledAt.toISOString(),
    latency_ms: 12,
  };
}

async function insertPoll(
  occurredAt: Date,
  entries: Array<{ steam: bigint; eos: string; team: number | null; squad: number | null }>,
) {
  await db.insert(events).values({
    eventId: uuidv7(),
    serverId: SERVER_ID,
    occurredAt,
    kind: 'rcon.players_polled',
    version: 1,
    actorKind: 'system',
    payload: pollPayload(occurredAt, entries),
  });
}

function rosterRows(matchId: string) {
  return db
    .select()
    .from(matchPlayers)
    .where(eq(matchPlayers.matchId, matchId))
    .orderBy(asc(matchPlayers.playSeconds));
}

beforeAll(async () => {
  await db.insert(servers).values({
    id: SERVER_ID,
    displayName: 'Match2 Test Server',
    slug: `match2-test-${SERVER_ID.slice(0, 8)}`,
  });
  await db.insert(players).values([
    {
      id: PLAYER_A,
      steamId64: STEAM_A,
      eosId: EOS_A,
      canonicalName: 'Alpha',
      canonicalNameNormalized: 'alpha',
    },
    {
      id: PLAYER_B,
      steamId64: STEAM_B,
      eosId: EOS_B,
      canonicalName: 'Bravo',
      canonicalNameNormalized: 'bravo',
    },
    {
      id: PLAYER_C,
      steamId64: null,
      eosId: EOS_C,
      canonicalName: 'Charlie',
      canonicalNameNormalized: 'charlie',
    },
    {
      id: PLAYER_D,
      steamId64: STEAM_D,
      eosId: EOS_D,
      canonicalName: 'Delta',
      canonicalNameNormalized: 'delta',
    },
  ]);
});

afterAll(async () => {
  await db.delete(matchPlayers).where(eq(matchPlayers.matchId, MATCH_ID));
  await db.delete(events).where(eq(events.serverId, SERVER_ID));
  await db.delete(playerSessions).where(eq(playerSessions.serverId, SERVER_ID));
  await db.delete(matches).where(eq(matches.serverId, SERVER_ID));
  await db.delete(players).where(eq(players.id, PLAYER_A));
  await db.delete(players).where(eq(players.id, PLAYER_B));
  await db.delete(players).where(eq(players.id, PLAYER_C));
  await db.delete(players).where(eq(players.id, PLAYER_D));
  await db.delete(servers).where(eq(servers.id, SERVER_ID));
  await db.$client.end();
});

beforeEach(async () => {
  await db.delete(matchPlayers).where(eq(matchPlayers.matchId, MATCH_ID));
  await db.delete(events).where(eq(events.serverId, SERVER_ID));
  await db.delete(playerSessions).where(eq(playerSessions.serverId, SERVER_ID));
  await db.delete(matches).where(eq(matches.serverId, SERVER_ID));
});

async function seedClosedMatchScenario() {
  await db.insert(matches).values({
    id: MATCH_ID,
    serverId: SERVER_ID,
    layer: 'Harju_RAAS_v1',
    startedAt: START,
    endedAt: END,
    endReason: 'ended',
    durationSeconds: 3600,
  });
  await db.insert(playerSessions).values([
    { playerId: PLAYER_A, serverId: SERVER_ID, connectedAt: at(-100), disconnectedAt: at(1800) },
    { playerId: PLAYER_B, serverId: SERVER_ID, connectedAt: at(0), disconnectedAt: at(600) },
    { playerId: PLAYER_B, serverId: SERVER_ID, connectedAt: at(900), disconnectedAt: null },
    { playerId: PLAYER_C, serverId: SERVER_ID, connectedAt: at(100), disconnectedAt: at(3500) },
  ]);
  await insertPoll(at(500), [{ steam: STEAM_A, eos: EOS_A, team: 2, squad: 9 }]);
  await insertPoll(at(1500), [
    { steam: STEAM_A, eos: EOS_A, team: 1, squad: 2 },
    { steam: STEAM_B, eos: EOS_B, team: 2, squad: 5 },
    { steam: STEAM_D, eos: EOS_D, team: 1, squad: 3 },
  ]);
  await insertPoll(new Date(END.getTime() + 300_000), [
    { steam: STEAM_A, eos: EOS_A, team: 2, squad: 7 },
  ]);
}

const closeCommand = {
  kind: 'close' as const,
  serverId: SERVER_ID,
  startedAt: START.toISOString(),
  endedAt: END.toISOString(),
  team1Faction: 'Russian Ground Forces',
  team2Faction: 'United States Army',
  team1Tickets: 250,
  team2Tickets: 0,
  winner: 'team1' as const,
};

describe('handleMatchClose', () => {
  it('writes the roster with team/squad and play_seconds from sessions and the last in-interval poll', async () => {
    await seedClosedMatchScenario();
    const result = await handleMatchClose(db, closeCommand);
    expect(result).toEqual({ written: 3 });

    const rows = await rosterRows(MATCH_ID);
    const byId = new Map(rows.map((row) => [row.playerId, row]));

    expect(rows).toHaveLength(3);
    expect(byId.has(PLAYER_D)).toBe(false);

    const a = byId.get(PLAYER_A);
    expect(a?.team).toBe(1);
    expect(a?.squadName).toBe('2');
    expect(a?.playSeconds).toBe(1800);
    expect(a?.joinedAt.toISOString()).toBe(START.toISOString());
    expect(a?.leftAt?.toISOString()).toBe(at(1800).toISOString());

    const b = byId.get(PLAYER_B);
    expect(b?.team).toBe(2);
    expect(b?.squadName).toBe('5');
    expect(b?.playSeconds).toBe(3300);
    expect(b?.leftAt).toBeNull();

    const c = byId.get(PLAYER_C);
    expect(c?.team).toBeNull();
    expect(c?.squadName).toBeNull();
    expect(c?.playSeconds).toBe(3400);
    expect(c?.leftAt?.toISOString()).toBe(at(3500).toISOString());
  });

  it('collapses a reconnect into a single row with summed play_seconds', async () => {
    await seedClosedMatchScenario();
    await handleMatchClose(db, closeCommand);
    const rows = await db
      .select()
      .from(matchPlayers)
      .where(and(eq(matchPlayers.matchId, MATCH_ID), eq(matchPlayers.playerId, PLAYER_B)));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.playSeconds).toBe(3300);
  });

  it('includes an EOS-only player (no steam_id64) in the roster', async () => {
    await seedClosedMatchScenario();
    await handleMatchClose(db, closeCommand);
    const rows = await db
      .select()
      .from(matchPlayers)
      .where(and(eq(matchPlayers.matchId, MATCH_ID), eq(matchPlayers.playerId, PLAYER_C)));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.team).toBeNull();
  });

  it('reconciles SUM(play_seconds) with the intersected session intervals', async () => {
    await seedClosedMatchScenario();
    await handleMatchClose(db, closeCommand);

    const [{ total }] = await db
      .select({ total: sql<number>`COALESCE(SUM(${matchPlayers.playSeconds}), 0)::int` })
      .from(matchPlayers)
      .where(eq(matchPlayers.matchId, MATCH_ID));

    const startMs = START.getTime();
    const endMs = END.getTime();
    const sessionRows = await db
      .select({
        connectedAt: playerSessions.connectedAt,
        disconnectedAt: playerSessions.disconnectedAt,
      })
      .from(playerSessions)
      .where(eq(playerSessions.serverId, SERVER_ID));
    const expected = sessionRows.reduce((sum, row) => {
      const pieceStart = Math.max(row.connectedAt.getTime(), startMs);
      const pieceEnd = Math.min(row.disconnectedAt?.getTime() ?? endMs, endMs);
      return pieceEnd > pieceStart ? sum + Math.floor((pieceEnd - pieceStart) / 1000) : sum;
    }, 0);

    expect(total).toBe(expected);
    expect(total).toBe(1800 + 3300 + 3400);
  });

  it('is idempotent when the close replays', async () => {
    await seedClosedMatchScenario();
    await handleMatchClose(db, closeCommand);
    const second = await handleMatchClose(db, closeCommand);
    expect(second).toEqual({ written: 3 });
    const rows = await rosterRows(MATCH_ID);
    expect(rows).toHaveLength(3);
  });

  it('ignores non-close commands', async () => {
    const result = await handleMatchClose(db, {
      kind: 'open',
      serverId: SERVER_ID,
      startedAt: START.toISOString(),
      layer: 'Harju_RAAS_v1',
    });
    expect(result).toBeNull();
  });
});

describe('computeOpenMatchRoster', () => {
  it('computes the live roster on the fly without writing match_players', async () => {
    await db.insert(matches).values({
      id: MATCH_ID,
      serverId: SERVER_ID,
      layer: 'Yehorivka_RAAS_v1',
      startedAt: START,
      endedAt: null,
    });
    await db.insert(playerSessions).values([
      { playerId: PLAYER_A, serverId: SERVER_ID, connectedAt: at(0), disconnectedAt: null },
      { playerId: PLAYER_B, serverId: SERVER_ID, connectedAt: at(600), disconnectedAt: null },
    ]);
    await insertPoll(at(700), [
      { steam: STEAM_A, eos: EOS_A, team: 1, squad: 4 },
      { steam: STEAM_B, eos: EOS_B, team: 2, squad: 1 },
    ]);

    const now = at(1200);
    const roster = await computeOpenMatchRoster(db, { matchId: MATCH_ID, now });
    const byId = new Map(roster.map((entry) => [entry.playerId, entry]));

    expect(roster).toHaveLength(2);
    expect(byId.get(PLAYER_A)?.playSeconds).toBe(1200);
    expect(byId.get(PLAYER_A)?.team).toBe(1);
    expect(byId.get(PLAYER_A)?.leftAt).toBeNull();
    expect(byId.get(PLAYER_B)?.playSeconds).toBe(600);
    expect(byId.get(PLAYER_B)?.squadName).toBe('1');

    const persisted = await rosterRows(MATCH_ID);
    expect(persisted).toHaveLength(0);
  });
});
