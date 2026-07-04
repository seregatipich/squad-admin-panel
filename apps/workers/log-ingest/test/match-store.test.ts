import { createDatabaseClient, matches, servers } from '@squad/db';
import { asc, eq } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeMatch, closeServerDown, handleMatchCommand, openMatch } from '../src/match/store.js';
import { LogIngestor } from '../src/parser/ingest.js';
import type { MatchCommand } from '../src/parser/match.js';

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error('DATABASE_URL must point at the match1 test database');

const db = createDatabaseClient(DATABASE_URL);

const SERVER_ID = uuidv7();
const START = '2026-07-05T18:00:00.000Z';
const END = '2026-07-05T18:45:00.000Z';
const SEED_THRESHOLD = 20;

function rowsForServer() {
  return db
    .select()
    .from(matches)
    .where(eq(matches.serverId, SERVER_ID))
    .orderBy(asc(matches.startedAt));
}

function fakeRedis(playerCount: number | null) {
  return {
    get: async () =>
      playerCount === null
        ? null
        : JSON.stringify({ state: 'connected', player_count: playerCount }),
  };
}

beforeAll(async () => {
  await db.insert(servers).values({
    id: SERVER_ID,
    displayName: 'Match Test Server',
    slug: `match-test-${SERVER_ID.slice(0, 8)}`,
  });
});

afterAll(async () => {
  await db.delete(matches).where(eq(matches.serverId, SERVER_ID));
  await db.delete(servers).where(eq(servers.id, SERVER_ID));
  await db.$client.end();
});

beforeEach(async () => {
  await db.delete(matches).where(eq(matches.serverId, SERVER_ID));
});

describe('match store', () => {
  it('assembles a played round with layer, factions, tickets, winner and duration', async () => {
    const opened = await openMatch(db, {
      serverId: SERVER_ID,
      startedAt: START,
      layer: 'Harju_RAAS_v1',
      onlineCount: 80,
      seedThreshold: SEED_THRESHOLD,
    });
    expect(opened.inserted).toBe(true);

    const closed = await closeMatch(db, {
      serverId: SERVER_ID,
      startedAt: START,
      endedAt: END,
      team1Faction: 'Russian Ground Forces',
      team2Faction: 'United States Army',
      team1Tickets: 342,
      team2Tickets: 0,
      winner: 'team1',
    });
    expect(closed.closed).toBe(true);

    const rows = await rowsForServer();
    expect(rows).toHaveLength(1);
    const match = rows[0];
    expect(match.layer).toBe('Harju_RAAS_v1');
    expect(match.map).toBe('Harju');
    expect(match.gameMode).toBe('RAAS');
    expect(match.team1Faction).toBe('Russian Ground Forces');
    expect(match.team2Faction).toBe('United States Army');
    expect(match.team1Tickets).toBe(342);
    expect(match.team2Tickets).toBe(0);
    expect(match.winner).toBe('team1');
    expect(match.isSeed).toBe(false);
    expect(match.endReason).toBe('ended');
    expect(match.durationSeconds).toBe(2700);
    expect(match.endedAt?.toISOString()).toBe(END);
  });

  it('closes an interrupted round as server_crashed with a null winner', async () => {
    await openMatch(db, {
      serverId: SERVER_ID,
      startedAt: START,
      layer: 'Yehorivka_RAAS_v1',
      onlineCount: 60,
      seedThreshold: SEED_THRESHOLD,
    });
    const crashTs = '2026-07-05T18:10:00.000Z';
    const result = await closeServerDown(db, {
      serverId: SERVER_ID,
      startedAt: START,
      endedAt: crashTs,
      endReason: 'server_crashed',
    });
    expect(result.closed).toBe(true);

    const rows = await rowsForServer();
    expect(rows[0].endReason).toBe('server_crashed');
    expect(rows[0].winner).toBeNull();
    expect(rows[0].durationSeconds).toBe(600);
    expect(rows[0].endedAt?.toISOString()).toBe(crashTs);
  });

  it('closes an open match by open-match lookup when the start offset is unknown', async () => {
    await openMatch(db, {
      serverId: SERVER_ID,
      startedAt: START,
      layer: 'Narva_Invasion_v1',
      onlineCount: 70,
      seedThreshold: SEED_THRESHOLD,
    });
    const result = await closeServerDown(db, {
      serverId: SERVER_ID,
      startedAt: null,
      endedAt: END,
      endReason: 'server_restarted',
    });
    expect(result.closed).toBe(true);
    const rows = await rowsForServer();
    expect(rows[0].endReason).toBe('server_restarted');
    expect(rows[0].durationSeconds).toBe(2700);
  });

  it('does not duplicate on offset-recovery replay of the same match.started', async () => {
    const first = await openMatch(db, {
      serverId: SERVER_ID,
      startedAt: START,
      layer: 'Harju_RAAS_v1',
      onlineCount: 80,
      seedThreshold: SEED_THRESHOLD,
    });
    const second = await openMatch(db, {
      serverId: SERVER_ID,
      startedAt: START,
      layer: 'Harju_RAAS_v1',
      onlineCount: 80,
      seedThreshold: SEED_THRESHOLD,
    });
    expect(first.inserted).toBe(true);
    expect(second.inserted).toBe(false);
    const rows = await rowsForServer();
    expect(rows).toHaveLength(1);
  });

  it('is a no-op when re-closing an already closed match', async () => {
    await openMatch(db, {
      serverId: SERVER_ID,
      startedAt: START,
      layer: 'Harju_RAAS_v1',
      onlineCount: 80,
      seedThreshold: SEED_THRESHOLD,
    });
    const params = {
      serverId: SERVER_ID,
      startedAt: START,
      endedAt: END,
      team1Faction: 'A',
      team2Faction: 'B',
      team1Tickets: 100,
      team2Tickets: 50,
      winner: 'team1' as const,
    };
    expect((await closeMatch(db, params)).closed).toBe(true);
    expect((await closeMatch(db, params)).closed).toBe(false);
    const rows = await rowsForServer();
    expect(rows).toHaveLength(1);
    expect(rows[0].winner).toBe('team1');
  });

  it('flags a Seed layer as is_seed regardless of population', async () => {
    await openMatch(db, {
      serverId: SERVER_ID,
      startedAt: START,
      layer: 'Sumari_Seed_v1',
      onlineCount: 90,
      seedThreshold: SEED_THRESHOLD,
    });
    const rows = await rowsForServer();
    expect(rows[0].gameMode).toBe('Seed');
    expect(rows[0].isSeed).toBe(true);
  });

  it('flags a low-population round as is_seed via the rcon online count', async () => {
    await handleMatchCommand(
      db,
      fakeRedis(11),
      { kind: 'open', serverId: SERVER_ID, startedAt: START, layer: 'Harju_RAAS_v1' },
      { seedThreshold: SEED_THRESHOLD },
    );
    const rows = await rowsForServer();
    expect(rows[0].isSeed).toBe(true);
  });
});

describe('LogIngestor → match store pipeline', () => {
  function drive(lines: string[]): Promise<void> {
    const commands: MatchCommand[] = [];
    const ingestor = new LogIngestor({
      serverId: SERVER_ID,
      beaconPort: 15000,
      onMatch: (command) => commands.push(command),
    });
    for (const line of lines) ingestor.ingest(line);
    return commands.reduce(
      (chain, command) =>
        chain.then(() =>
          handleMatchCommand(db, fakeRedis(80), command, { seedThreshold: SEED_THRESHOLD }),
        ),
      Promise.resolve(),
    );
  }

  it('persists a full round from raw SquadGame.log lines', async () => {
    await drive([
      '[2026.07.05-18.00.00:000][100]LogWorld: Bringing World /Game/Maps/Harju/Gameplay_Layers/Harju_RAAS_v1 up for play (max tick rate 50)',
      '[2026.07.05-18.00.10:000][110]LogGameState: Match State Changed from WaitingToStart to InProgress',
      '[2026.07.05-18.45.00:000][900]LogSquadGameEvents: Display: Team 1, 7th Mechanized Brigade ( Russian Ground Forces ) has won the match with 342 Tickets on layer Harju RAAS v1',
      '[2026.07.05-18.45.00:010][900]LogSquadGameEvents: Display: Team 2, 1st Cavalry ( United States Army ) has lost the match with 0 Tickets on layer Harju RAAS v1',
      '[2026.07.05-18.45.01:000][901]LogGameState: Match State Changed from InProgress to WaitingPostMatch',
    ]);
    const rows = await rowsForServer();
    expect(rows).toHaveLength(1);
    expect(rows[0].layer).toBe('Harju_RAAS_v1');
    expect(rows[0].gameMode).toBe('RAAS');
    expect(rows[0].winner).toBe('team1');
    expect(rows[0].team1Faction).toBe('Russian Ground Forces');
    expect(rows[0].team2Faction).toBe('United States Army');
    expect(rows[0].team2Tickets).toBe(0);
    expect(rows[0].endReason).toBe('ended');
    expect(rows[0].durationSeconds).toBe(2691);
  });

  it('persists a server crash mid-round as server_crashed', async () => {
    await drive([
      '[2026.07.05-18.00.00:000][100]LogWorld: Bringing World /Game/Maps/Narva/Gameplay_Layers/Narva_Invasion_v1 up for play (max tick rate 50)',
      '[2026.07.05-18.00.10:000][110]LogGameState: Match State Changed from WaitingToStart to InProgress',
      '[2026.07.05-18.12.00:000][500]LogCore: FUnixPlatformMisc::RequestExit(bForce=false, ReturnCode=134)',
    ]);
    const rows = await rowsForServer();
    expect(rows).toHaveLength(1);
    expect(rows[0].gameMode).toBe('Invasion');
    expect(rows[0].endReason).toBe('server_crashed');
    expect(rows[0].winner).toBeNull();
  });
});
