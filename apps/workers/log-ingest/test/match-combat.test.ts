import {
  createDatabaseClient,
  events,
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

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error('DATABASE_URL must point at the match3 test database');

const db = createDatabaseClient(DATABASE_URL);

const SERVER_ID = uuidv7();
const PLAYER_A = uuidv7();
const PLAYER_B = uuidv7();
const PLAYER_C = uuidv7();
const PLAYER_D = uuidv7();
const PLAYER_E = uuidv7();
const MATCH_ID = uuidv7();

const START = new Date('2026-07-05T18:00:00.000Z');
const END = new Date(START.getTime() + 3600_000);
const at = (offsetSeconds: number) => new Date(START.getTime() + offsetSeconds * 1000);

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

async function insertCombat(
  kind: 'combat_death' | 'combat_wound' | 'combat_revive' | 'combat_damage',
  occurredAt: Date,
  payload: Record<string, unknown>,
) {
  await db.insert(events).values({
    eventId: uuidv7(),
    serverId: SERVER_ID,
    occurredAt,
    kind,
    version: 1,
    actorKind: 'system',
    payload,
  });
}

function deathPayload(
  attacker: string | null,
  victim: string,
  extra: { isTeamkill?: boolean; isSuicide?: boolean } = {},
) {
  return {
    match_id: MATCH_ID,
    attacker_player_id: attacker,
    victim_player_id: victim,
    is_teamkill: extra.isTeamkill ?? false,
    is_suicide: extra.isSuicide ?? false,
  };
}

async function seedRoster() {
  await db.insert(matches).values({
    id: MATCH_ID,
    serverId: SERVER_ID,
    layer: 'Harju_RAAS_v1',
    startedAt: START,
    endedAt: END,
    endReason: 'ended',
    durationSeconds: 3600,
  });
  await db.insert(playerSessions).values(
    [PLAYER_A, PLAYER_B, PLAYER_C, PLAYER_D, PLAYER_E].map((playerId) => ({
      playerId,
      serverId: SERVER_ID,
      connectedAt: at(0),
      disconnectedAt: END,
    })),
  );
}

async function seedCombatRound() {
  await insertCombat('combat_death', at(100), deathPayload(PLAYER_A, PLAYER_B));
  await insertCombat('combat_death', at(200), deathPayload(PLAYER_A, PLAYER_C));
  await insertCombat(
    'combat_death',
    at(300),
    deathPayload(PLAYER_A, PLAYER_D, { isTeamkill: true }),
  );
  await insertCombat('combat_death', at(400), deathPayload(PLAYER_B, PLAYER_A));
  await insertCombat(
    'combat_death',
    at(500),
    deathPayload(PLAYER_A, PLAYER_A, { isSuicide: true }),
  );
  await insertCombat('combat_wound', at(600), {
    match_id: MATCH_ID,
    attacker_player_id: PLAYER_A,
    victim_player_id: PLAYER_C,
    is_teamkill: false,
    is_suicide: false,
  });
  await insertCombat('combat_revive', at(700), {
    match_id: MATCH_ID,
    medic_player_id: PLAYER_C,
    revived_player_id: PLAYER_A,
  });
}

function rosterById(matchId: string) {
  return db
    .select()
    .from(matchPlayers)
    .where(eq(matchPlayers.matchId, matchId))
    .then((rows) => new Map(rows.map((row) => [row.playerId, row])));
}

beforeAll(async () => {
  await db.insert(servers).values({
    id: SERVER_ID,
    displayName: 'Match3 Test Server',
    slug: `match3-test-${SERVER_ID.slice(0, 8)}`,
  });
  await db.insert(players).values(
    [
      [PLAYER_A, 'Alpha'],
      [PLAYER_B, 'Bravo'],
      [PLAYER_C, 'Charlie'],
      [PLAYER_D, 'Delta'],
      [PLAYER_E, 'Echo'],
    ].map(([id, name]) => ({
      id,
      canonicalName: name,
      canonicalNameNormalized: name.toLowerCase(),
    })),
  );
});

afterAll(async () => {
  await db.delete(matchPlayers).where(eq(matchPlayers.matchId, MATCH_ID));
  await db.delete(events).where(eq(events.serverId, SERVER_ID));
  await db.delete(playerSessions).where(eq(playerSessions.serverId, SERVER_ID));
  await db.delete(matches).where(eq(matches.serverId, SERVER_ID));
  for (const id of [PLAYER_A, PLAYER_B, PLAYER_C, PLAYER_D, PLAYER_E]) {
    await db.delete(players).where(eq(players.id, id));
  }
  await db.delete(servers).where(eq(servers.id, SERVER_ID));
  await db.$client.end();
});

beforeEach(async () => {
  await db.delete(matchPlayers).where(eq(matchPlayers.matchId, MATCH_ID));
  await db.delete(events).where(eq(events.serverId, SERVER_ID));
  await db.delete(playerSessions).where(eq(playerSessions.serverId, SERVER_ID));
  await db.delete(matches).where(eq(matches.serverId, SERVER_ID));
});

describe('handleMatchClose combat aggregation (MATCH-3)', () => {
  it('fills per-player kills/deaths/wounds/revives from combat events in the interval', async () => {
    await seedRoster();
    await seedCombatRound();
    await handleMatchClose(db, closeCommand);

    const roster = await rosterById(MATCH_ID);
    expect(roster.get(PLAYER_A)).toMatchObject({
      kills: 2,
      deaths: 2,
      teamkills: 1,
      wounds: 1,
      revives: 0,
    });
    expect(roster.get(PLAYER_B)).toMatchObject({ kills: 1, deaths: 1, teamkills: 0 });
    expect(roster.get(PLAYER_C)).toMatchObject({ deaths: 1, revives: 1 });
    expect(roster.get(PLAYER_D)).toMatchObject({ kills: 0, deaths: 1, teamkills: 0 });
  });

  it('excludes teamkills from kills but records the victim death', async () => {
    await seedRoster();
    await seedCombatRound();
    await handleMatchClose(db, closeCommand);

    const roster = await rosterById(MATCH_ID);
    expect(roster.get(PLAYER_A)?.kills).toBe(2);
    expect(roster.get(PLAYER_A)?.teamkills).toBe(1);
    expect(roster.get(PLAYER_D)?.deaths).toBe(1);
    expect(roster.get(PLAYER_D)?.kills).toBe(0);
  });

  it('assigns zeros (not NULL) to roster players without combat when the match has combat data', async () => {
    await seedRoster();
    await seedCombatRound();
    await handleMatchClose(db, closeCommand);

    const roster = await rosterById(MATCH_ID);
    expect(roster.get(PLAYER_E)).toMatchObject({
      kills: 0,
      deaths: 0,
      teamkills: 0,
      wounds: 0,
      revives: 0,
    });
  });

  it('leaves combat columns NULL for a match played before combat parsing existed', async () => {
    await seedRoster();
    await handleMatchClose(db, closeCommand);

    const roster = await rosterById(MATCH_ID);
    const a = roster.get(PLAYER_A);
    expect(a?.kills).toBeNull();
    expect(a?.deaths).toBeNull();
    expect(a?.teamkills).toBeNull();
    expect(a?.wounds).toBeNull();
    expect(a?.revives).toBeNull();
  });

  it('is idempotent: recomputing a closed match yields the same combat totals', async () => {
    await seedRoster();
    await seedCombatRound();
    await handleMatchClose(db, closeCommand);
    const first = await rosterById(MATCH_ID);
    await handleMatchClose(db, closeCommand);
    const second = await rosterById(MATCH_ID);

    for (const id of [PLAYER_A, PLAYER_B, PLAYER_C, PLAYER_D, PLAYER_E]) {
      expect(second.get(id)).toMatchObject({
        kills: first.get(id)?.kills ?? null,
        deaths: first.get(id)?.deaths ?? null,
        teamkills: first.get(id)?.teamkills ?? null,
        wounds: first.get(id)?.wounds ?? null,
        revives: first.get(id)?.revives ?? null,
      });
    }
  });
});
