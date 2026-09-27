import { randomBytes, randomUUID } from 'node:crypto';
import type { DatabaseClient } from '@squad/db';
import * as schema from '@squad/db/schema';
import { playerSessions, players, servers } from '@squad/db/schema';
import { and, eq, isNull } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { RconPlayer } from '../src/parse-list-players.js';
import { closeServerSessions, reconcilePlayerSessions, upsertPlayers } from '../src/persist.js';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;

function makePlayer(overrides: Partial<RconPlayer> = {}): RconPlayer {
  return {
    rcon_id: 1,
    eos_id: `eos-sess-${randomBytes(8).toString('hex')}`,
    steam_id64: null,
    name: 'SessionTester',
    team_id: 1,
    squad_id: 1,
    is_leader: false,
    role: 'USA_Medic_01',
    ...overrides,
  };
}

let sql: ReturnType<typeof postgres>;
let db: DatabaseClient;
let serverId: string;

async function playerIdByEos(eosId: string): Promise<string> {
  const [row] = await db.select({ id: players.id }).from(players).where(eq(players.eosId, eosId));
  if (!row) throw new Error(`no player for eos_id=${eosId}`);
  return row.id;
}

async function sessionsFor(playerId: string) {
  return db
    .select()
    .from(playerSessions)
    .where(and(eq(playerSessions.playerId, playerId), eq(playerSessions.serverId, serverId)));
}

async function openSessionCount(): Promise<number> {
  const rows = await db
    .select({ id: playerSessions.id })
    .from(playerSessions)
    .where(and(eq(playerSessions.serverId, serverId), isNull(playerSessions.disconnectedAt)));
  return rows.length;
}

beforeAll(() => {
  if (!DATABASE_URL) return;
  sql = postgres(DATABASE_URL, { max: 1, onnotice: () => undefined });
  db = drizzle(sql, { schema }) as unknown as DatabaseClient;
});

// A server per test: reconciling a roster closes every other open session of
// the server, so a session a previous test left open would be counted by the
// next one's `closed` total whenever the order changes.
beforeEach(async () => {
  if (!DATABASE_URL) return;
  serverId = randomUUID();
  await db.insert(servers).values({
    id: serverId,
    displayName: 'Player Sessions Test Server',
    slug: `player-sessions-test-${randomBytes(4).toString('hex')}`,
  });
});

afterAll(async () => {
  if (sql) await sql.end();
});

describeIfDb('reconcilePlayerSessions', () => {
  it('opens one session per online player and is idempotent across polls', async () => {
    const a = makePlayer();
    const b = makePlayer();
    await upsertPlayers(db, [a, b]);

    const poll1 = new Date('2026-03-01T00:00:00.000Z');
    const first = await reconcilePlayerSessions(db, {
      serverId,
      onlinePlayers: [a, b],
      pollAt: poll1,
    });
    expect(first).toEqual({ opened: 2, closed: 0 });

    const poll2 = new Date('2026-03-01T00:00:30.000Z');
    const second = await reconcilePlayerSessions(db, {
      serverId,
      onlinePlayers: [a, b],
      pollAt: poll2,
    });
    expect(second).toEqual({ opened: 0, closed: 0 });

    const rowsA = await sessionsFor(await playerIdByEos(a.eos_id));
    expect(rowsA).toHaveLength(1);
    expect(rowsA[0]?.disconnectedAt).toBeNull();
    expect(rowsA[0]?.mode).toBe('online');
  });

  it('closes the session of a player who left the roster and records its duration', async () => {
    const stays = makePlayer();
    const leaves = makePlayer();
    await upsertPlayers(db, [stays, leaves]);

    const poll1 = new Date('2026-03-02T00:00:00.000Z');
    await reconcilePlayerSessions(db, {
      serverId,
      onlinePlayers: [stays, leaves],
      pollAt: poll1,
    });

    const poll2 = new Date('2026-03-02T00:10:00.000Z');
    const result = await reconcilePlayerSessions(db, {
      serverId,
      onlinePlayers: [stays],
      pollAt: poll2,
    });
    expect(result).toEqual({ opened: 0, closed: 1 });

    const [leftRow] = await sessionsFor(await playerIdByEos(leaves.eos_id));
    expect(leftRow?.disconnectedAt?.toISOString()).toBe(poll2.toISOString());
    expect(leftRow?.durationSeconds).toBe(600);
    expect(leftRow?.closedReason).toBe('disconnect');

    const [stayRow] = await sessionsFor(await playerIdByEos(stays.eos_id));
    expect(stayRow?.disconnectedAt).toBeNull();
  });

  it('closes every open session when the roster is empty', async () => {
    const solo = makePlayer();
    await upsertPlayers(db, [solo]);
    await reconcilePlayerSessions(db, {
      serverId,
      onlinePlayers: [solo],
      pollAt: new Date('2026-03-03T00:00:00.000Z'),
    });
    const before = await openSessionCount();
    expect(before).toBeGreaterThan(0);

    const result = await reconcilePlayerSessions(db, {
      serverId,
      onlinePlayers: [],
      pollAt: new Date('2026-03-03T00:05:00.000Z'),
    });
    expect(result.closed).toBe(before);
    expect(await openSessionCount()).toBe(0);
  });

  it('opens a seed-mode session while the server is seeding', async () => {
    const seeder = makePlayer();
    await upsertPlayers(db, [seeder]);
    await reconcilePlayerSessions(db, {
      serverId,
      onlinePlayers: [seeder],
      pollAt: new Date('2026-03-04T00:00:00.000Z'),
      mode: 'seed',
    });
    const [row] = await sessionsFor(await playerIdByEos(seeder.eos_id));
    expect(row?.mode).toBe('seed');
  });

  it('backdates connected_at to the roster first-seen instant, clamped to two poll intervals', async () => {
    const recent = makePlayer();
    const stale = makePlayer();
    await upsertPlayers(db, [recent, stale]);

    const pollAt = new Date('2026-03-05T00:01:00.000Z');
    const firstSeenByEosId = new Map([
      [recent.eos_id, '2026-03-05T00:00:50.000Z'],
      // Older than 2 × 30s: an RCON reconnect must not credit the offline gap.
      [stale.eos_id, '2026-03-04T00:00:00.000Z'],
    ]);
    await reconcilePlayerSessions(db, {
      serverId,
      onlinePlayers: [recent, stale],
      pollAt,
      firstSeenByEosId,
      pollIntervalMs: 30_000,
    });

    const [recentRow] = await sessionsFor(await playerIdByEos(recent.eos_id));
    expect(recentRow?.connectedAt?.toISOString()).toBe('2026-03-05T00:00:50.000Z');
    const [staleRow] = await sessionsFor(await playerIdByEos(stale.eos_id));
    expect(staleRow?.connectedAt?.toISOString()).toBe('2026-03-05T00:00:00.000Z');
  });
});

describeIfDb('closeServerSessions', () => {
  it('closes all open sessions of the server at the given instant', async () => {
    const one = makePlayer();
    const two = makePlayer();
    await upsertPlayers(db, [one, two]);
    await reconcilePlayerSessions(db, {
      serverId,
      onlinePlayers: [one, two],
      pollAt: new Date('2026-03-06T00:00:00.000Z'),
    });

    const closedAt = new Date('2026-03-06T00:02:00.000Z');
    const closed = await closeServerSessions(db, serverId, closedAt, 'server_crashed');
    expect(closed).toBeGreaterThanOrEqual(2);
    expect(await openSessionCount()).toBe(0);

    const [row] = await sessionsFor(await playerIdByEos(one.eos_id));
    expect(row?.closedReason).toBe('server_crashed');
    expect(row?.durationSeconds).toBe(120);
  });
});
