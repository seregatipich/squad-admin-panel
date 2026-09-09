import {
  createDatabaseClient,
  matches,
  matchPlayers,
  playerSessions,
  players,
  servers,
} from '@squad/db';
import { eq } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { handleMatchClose } from '../src/match-roster/store.js';

/**
 * Regression: production writes two `matches` rows per round — a ~3 ms "ghost"
 * carrying the layer and the real round with `layer = NULL` (issue #330). While
 * `player_sessions` was empty this was invisible, because every roster came back
 * empty. Once the RCON presence projection started filling sessions, the ghost's
 * window overlaps every open session, so `handleMatchClose` would write a full
 * roster of `play_seconds = 0` rows against it — doubling `COUNT(DISTINCT
 * matches.id)` in the dossier's «Скилл» tab and polluting every match list.
 *
 * `filterRosterByPlaySeconds` (with `DEFAULT_JOIN_GRACE_SECONDS`) exists for
 * exactly this and had no caller. These tests pin that it is applied: a
 * millisecond-long ghost writes nothing, and a player who barely tapped into a
 * real round is not counted as having played it, while everyone who actually
 * played still is.
 */

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error('DATABASE_URL must point at the log-ingest test database');

const db = createDatabaseClient(DATABASE_URL);

const SERVER_ID = uuidv7();
const PLAYER_A = uuidv7();
const PLAYER_B = uuidv7();
const GHOST_MATCH_ID = uuidv7();
const REAL_MATCH_ID = uuidv7();

const ROUND_START = new Date('2026-09-09T20:00:00.000Z');
const ROUND_END = new Date(ROUND_START.getTime() + 2400_000); // 40 min

beforeAll(async () => {
  await db.insert(servers).values({
    id: SERVER_ID,
    displayName: 'Ghost Match Test Server',
    slug: `ghost-match-${SERVER_ID.slice(0, 8)}`,
  });
  await db.insert(players).values([
    {
      id: PLAYER_A,
      steamId64: 76561198000800001n,
      eosId: '0008aaaa0008aaaa0008aaaa0008aaaa',
      canonicalName: 'GhostAlpha',
      canonicalNameNormalized: 'ghostalpha',
    },
    {
      id: PLAYER_B,
      steamId64: 76561198000800002n,
      eosId: '0008bbbb0008bbbb0008bbbb0008bbbb',
      canonicalName: 'GhostBravo',
      canonicalNameNormalized: 'ghostbravo',
    },
  ]);
});

afterAll(async () => {
  await db.delete(matchPlayers).where(eq(matchPlayers.matchId, GHOST_MATCH_ID));
  await db.delete(matchPlayers).where(eq(matchPlayers.matchId, REAL_MATCH_ID));
  await db.delete(playerSessions).where(eq(playerSessions.serverId, SERVER_ID));
  await db.delete(matches).where(eq(matches.serverId, SERVER_ID));
  await db.delete(players).where(eq(players.id, PLAYER_A));
  await db.delete(players).where(eq(players.id, PLAYER_B));
  await db.delete(servers).where(eq(servers.id, SERVER_ID));
  await db.$client.end();
});

beforeEach(async () => {
  await db.delete(matchPlayers).where(eq(matchPlayers.matchId, GHOST_MATCH_ID));
  await db.delete(matchPlayers).where(eq(matchPlayers.matchId, REAL_MATCH_ID));
  await db.delete(playerSessions).where(eq(playerSessions.serverId, SERVER_ID));
  await db.delete(matches).where(eq(matches.serverId, SERVER_ID));
});

/** Both players connected for the whole round, as the RCON projection would record them. */
async function openSessionsForWholeRound() {
  await db.insert(playerSessions).values([
    { playerId: PLAYER_A, serverId: SERVER_ID, connectedAt: ROUND_START, disconnectedAt: null },
    { playerId: PLAYER_B, serverId: SERVER_ID, connectedAt: ROUND_START, disconnectedAt: null },
  ]);
}

function close(startedAt: Date, endedAt: Date) {
  return handleMatchClose(db, {
    kind: 'close',
    serverId: SERVER_ID,
    startedAt: startedAt.toISOString(),
    endedAt: endedAt.toISOString(),
    reason: 'ended',
  } as never);
}

describe('ghost matches never receive a roster', () => {
  it('writes no match_players for a millisecond-long ghost match', async () => {
    const ghostEnd = new Date(ROUND_START.getTime() + 3); // the real production shape: 3 ms
    await db.insert(matches).values({
      id: GHOST_MATCH_ID,
      serverId: SERVER_ID,
      layer: 'Narva_RAAS_v1',
      startedAt: ROUND_START,
      endedAt: ghostEnd,
      endReason: 'ended',
      durationSeconds: 0,
    });
    await openSessionsForWholeRound();

    const result = await close(ROUND_START, ghostEnd);

    expect(result).toEqual({ written: 0 });
    const roster = await db
      .select()
      .from(matchPlayers)
      .where(eq(matchPlayers.matchId, GHOST_MATCH_ID));
    expect(roster).toHaveLength(0);
  });

  it('still writes the full roster for the real round', async () => {
    await db.insert(matches).values({
      id: REAL_MATCH_ID,
      serverId: SERVER_ID,
      layer: null,
      startedAt: ROUND_START,
      endedAt: ROUND_END,
      endReason: 'ended',
      durationSeconds: 2400,
    });
    await openSessionsForWholeRound();

    const result = await close(ROUND_START, ROUND_END);

    expect(result).toEqual({ written: 2 });
    const roster = await db
      .select()
      .from(matchPlayers)
      .where(eq(matchPlayers.matchId, REAL_MATCH_ID));
    expect(roster).toHaveLength(2);
    expect(roster.every((r) => r.playSeconds === 2400)).toBe(true);
  });

  it('drops a player who was present for less than the join grace, keeps the rest', async () => {
    await db.insert(matches).values({
      id: REAL_MATCH_ID,
      serverId: SERVER_ID,
      layer: null,
      startedAt: ROUND_START,
      endedAt: ROUND_END,
      endReason: 'ended',
      durationSeconds: 2400,
    });
    await db.insert(playerSessions).values([
      { playerId: PLAYER_A, serverId: SERVER_ID, connectedAt: ROUND_START, disconnectedAt: null },
      {
        playerId: PLAYER_B,
        serverId: SERVER_ID,
        connectedAt: ROUND_START,
        // 30 s — a connect-and-leave, below DEFAULT_JOIN_GRACE_SECONDS
        disconnectedAt: new Date(ROUND_START.getTime() + 30_000),
      },
    ]);

    const result = await close(ROUND_START, ROUND_END);

    expect(result).toEqual({ written: 1 });
    const roster = await db
      .select()
      .from(matchPlayers)
      .where(eq(matchPlayers.matchId, REAL_MATCH_ID));
    expect(roster).toHaveLength(1);
    expect(roster[0]?.playerId).toBe(PLAYER_A);
  });
});
