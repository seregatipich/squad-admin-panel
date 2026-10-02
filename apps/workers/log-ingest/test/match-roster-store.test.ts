import {
  createDatabaseClient,
  matches,
  matchPlayers,
  playerSessions,
  players,
  servers,
} from '@squad/db';
import { and, asc, eq, sql } from 'drizzle-orm';
import Redis from 'ioredis';
import { v7 as uuidv7 } from 'uuid';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { describeIfDbAndRedis } from '../../../../packages/db/test/helpers/describe-if.js';
import { handleMatchClose, type RosterSnapshotReader } from '../src/match-roster/store.js';

const DATABASE_URL = process.env.DATABASE_URL;

const db = createDatabaseClient(DATABASE_URL ?? 'postgres://unused/unused');
const redis = new Redis(process.env.REDIS_URL ?? 'redis://127.0.0.1:6379/3', {
  maxRetriesPerRequest: null,
  lazyConnect: true,
});

const SERVER_ID = uuidv7();
const PLAYER_A = uuidv7();
const PLAYER_B = uuidv7();
const PLAYER_C = uuidv7();
const PLAYER_D = uuidv7();

const STEAM_A = 76561198000600001n;
const STEAM_B = 76561198000600002n;
const STEAM_D = 76561198000600004n;
const EOS_A = '0006aaaa0006aaaa0006aaaa0006aaaa';
const EOS_B = '0006bbbb0006bbbb0006bbbb0006bbbb';
const EOS_C = '0006cccc0006cccc0006cccc0006cccc';
const EOS_D = '0006dddd0006dddd0006dddd0006dddd';

const START = new Date('2026-07-05T18:00:00.000Z');
const END = new Date(START.getTime() + 3600_000);
const at = (offsetSeconds: number) => new Date(START.getTime() + offsetSeconds * 1000);

const MATCH_ID = uuidv7();
const ROSTER_KEY = `rcon:roster:${SERVER_ID}`;
const SQUADS_KEY = `rcon:squads:${SERVER_ID}`;

interface SnapshotEntry {
  steam: bigint | null;
  eos: string;
  team: number | null;
  squad: number | null;
}

/** Writes what worker-rcon caches after a roster refresh at `polledAt`. */
async function writeRosterSnapshot(
  polledAt: Date,
  entries: SnapshotEntry[],
  squads: Array<{ team: number; squad: number; name: string }>,
) {
  const polled_at = polledAt.toISOString();
  await redis.set(
    ROSTER_KEY,
    JSON.stringify({
      server_id: SERVER_ID,
      polled_at,
      players: entries.map((entry, index) => ({
        rcon_id: index,
        eos_id: entry.eos,
        steam_id64: entry.steam?.toString() ?? null,
        name: 'player',
        team_id: entry.team,
        squad_id: entry.squad,
        is_leader: false,
        role: null,
        first_seen_at: polled_at,
      })),
    }),
  );
  await redis.set(
    SQUADS_KEY,
    JSON.stringify({
      server_id: SERVER_ID,
      polled_at,
      squads: squads.map((squad) => ({
        team_id: squad.team,
        team_name: squad.team === 1 ? 'Russian Ground Forces' : 'United States Army',
        squad_id: squad.squad,
        name: squad.name,
        size: 1,
        locked: false,
        creator_name: 'player',
        creator_eos_id: null,
        creator_steam_id64: null,
        is_command_squad: false,
      })),
    }),
  );
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
  await db.delete(playerSessions).where(eq(playerSessions.serverId, SERVER_ID));
  await db.delete(matches).where(eq(matches.serverId, SERVER_ID));
  await db.delete(players).where(eq(players.id, PLAYER_A));
  await db.delete(players).where(eq(players.id, PLAYER_B));
  await db.delete(players).where(eq(players.id, PLAYER_C));
  await db.delete(players).where(eq(players.id, PLAYER_D));
  await db.delete(servers).where(eq(servers.id, SERVER_ID));
  await redis.del(ROSTER_KEY, SQUADS_KEY);
  await redis.quit();
  await db.$client.end();
});

beforeEach(async () => {
  await db.delete(matchPlayers).where(eq(matchPlayers.matchId, MATCH_ID));
  await db.delete(playerSessions).where(eq(playerSessions.serverId, SERVER_ID));
  await db.delete(matches).where(eq(matches.serverId, SERVER_ID));
  await redis.del(ROSTER_KEY, SQUADS_KEY);
});

/**
 * A left at 1800 s, B reconnected and is online at close, C left at 3500 s,
 * D is in the snapshot but never had a session. The snapshot is the roster
 * five seconds before the match ended, as worker-rcon would have cached it.
 */
async function seedClosedMatchScenario(snapshotAt: Date = new Date(END.getTime() - 5_000)) {
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
  await writeRosterSnapshot(
    snapshotAt,
    [
      { steam: STEAM_B, eos: EOS_B, team: 2, squad: 5 },
      { steam: STEAM_D, eos: EOS_D, team: 1, squad: 3 },
    ],
    [
      { team: 2, squad: 5, name: 'Bravo Squad' },
      { team: 1, squad: 3, name: 'Delta Squad' },
    ],
  );
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

describeIfDbAndRedis('handleMatchClose', () => {
  it('names each squad from the Redis snapshots (regression: squad_name was always null)', async () => {
    await seedClosedMatchScenario();
    const result = await handleMatchClose(db, redis, closeCommand);
    expect(result).toEqual({ written: 3 });

    const rows = await rosterRows(MATCH_ID);
    const byId = new Map(rows.map((row) => [row.playerId, row]));
    expect(rows).toHaveLength(3);
    expect(byId.has(PLAYER_D)).toBe(false);

    const b = byId.get(PLAYER_B);
    expect(b?.team).toBe(2);
    expect(b?.squadName).toBe('Bravo Squad');
    expect(b?.playSeconds).toBe(3300);
    expect(b?.leftAt).toBeNull();

    // A and C left before the close, so the final roster cannot place them.
    const a = byId.get(PLAYER_A);
    expect(a?.team).toBeNull();
    expect(a?.squadName).toBeNull();
    expect(a?.playSeconds).toBe(1800);
    expect(a?.joinedAt.toISOString()).toBe(START.toISOString());
    expect(a?.leftAt?.toISOString()).toBe(at(1800).toISOString());

    const c = byId.get(PLAYER_C);
    expect(c?.team).toBeNull();
    expect(c?.squadName).toBeNull();
    expect(c?.playSeconds).toBe(3400);
  });

  it('keeps the team but no squad name when the squads snapshot is missing', async () => {
    await seedClosedMatchScenario();
    await redis.del(SQUADS_KEY);
    await handleMatchClose(db, redis, closeCommand);
    const [b] = await db
      .select()
      .from(matchPlayers)
      .where(and(eq(matchPlayers.matchId, MATCH_ID), eq(matchPlayers.playerId, PLAYER_B)));
    expect(b?.team).toBe(2);
    expect(b?.squadName).toBeNull();
  });

  it('ignores a roster snapshot polled after the match window', async () => {
    await seedClosedMatchScenario(new Date(END.getTime() + 10 * 60_000));
    await handleMatchClose(db, redis, closeCommand);
    const rows = await rosterRows(MATCH_ID);
    expect(rows).toHaveLength(3);
    expect(rows.every((row) => row.team === null && row.squadName === null)).toBe(true);
  });

  it('still writes the roster when Redis is unavailable', async () => {
    await seedClosedMatchScenario();
    const down: RosterSnapshotReader = {
      mget: async () => {
        throw new Error('redis down');
      },
    };
    expect(await handleMatchClose(db, down, closeCommand)).toEqual({ written: 3 });
    const rows = await rosterRows(MATCH_ID);
    expect(rows.every((row) => row.squadName === null)).toBe(true);
  });

  it('collapses a reconnect into a single row with summed play_seconds', async () => {
    await seedClosedMatchScenario();
    await handleMatchClose(db, redis, closeCommand);
    const rows = await db
      .select()
      .from(matchPlayers)
      .where(and(eq(matchPlayers.matchId, MATCH_ID), eq(matchPlayers.playerId, PLAYER_B)));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.playSeconds).toBe(3300);
  });

  it('includes an EOS-only player (no steam_id64) in the roster', async () => {
    await seedClosedMatchScenario();
    await handleMatchClose(db, redis, closeCommand);
    const rows = await db
      .select()
      .from(matchPlayers)
      .where(and(eq(matchPlayers.matchId, MATCH_ID), eq(matchPlayers.playerId, PLAYER_C)));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.team).toBeNull();
  });

  it('reconciles SUM(play_seconds) with the intersected session intervals', async () => {
    await seedClosedMatchScenario();
    await handleMatchClose(db, redis, closeCommand);

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

  // Regression for #63 finding 923: loadSessions must keep a lower bound on
  // connectedAt so partition pruning still applies, without excluding a
  // session that started shortly before the match and is still open.
  it('bounds how far before the match a session may have connected (#63 finding 923)', async () => {
    await seedClosedMatchScenario();
    const ancientSessionPlayer = PLAYER_D;
    await db.insert(playerSessions).values({
      playerId: ancientSessionPlayer,
      serverId: SERVER_ID,
      connectedAt: new Date(START.getTime() - 48 * 60 * 60 * 1000),
      disconnectedAt: null,
    });
    await handleMatchClose(db, redis, closeCommand);
    const rows = await rosterRows(MATCH_ID);
    expect(rows.some((row) => row.playerId === ancientSessionPlayer)).toBe(false);
  });

  it('is idempotent when the close replays', async () => {
    await seedClosedMatchScenario();
    await handleMatchClose(db, redis, closeCommand);
    const second = await handleMatchClose(db, redis, closeCommand);
    expect(second).toEqual({ written: 3 });
    expect(await rosterRows(MATCH_ID)).toHaveLength(3);
  });

  it('ignores non-close commands', async () => {
    const result = await handleMatchClose(db, redis, {
      kind: 'open',
      serverId: SERVER_ID,
      startedAt: START.toISOString(),
      layer: 'Harju_RAAS_v1',
    });
    expect(result).toBeNull();
  });
});
