import { randomInt, randomUUID } from 'node:crypto';
import { createDatabaseClient, players, sessions } from '@squad/db';
import { eq } from 'drizzle-orm';
import type Redis from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { revokeAllSessionsForPlayer } from '../src/tick.js';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;

const PLAYER_ID = randomUUID();
const PLAYER_STEAM_ID = 76561198915100000n + BigInt(randomInt(1, 1_000_000));
const SESSION_A = `seed-reward-revoke-${PLAYER_ID}-a`;

const db = DATABASE_URL ? createDatabaseClient(DATABASE_URL) : null;

beforeAll(async () => {
  if (!db) return;
  await db.insert(players).values({
    id: PLAYER_ID,
    steamId64: PLAYER_STEAM_ID,
    canonicalName: 'Награждённый сидер',
    canonicalNameNormalized: 'награждённый сидер',
  });
});

afterAll(async () => {
  if (!db) return;
  await db.delete(sessions).where(eq(sessions.playerId, PLAYER_ID));
  await db.delete(players).where(eq(players.steamId64, PLAYER_STEAM_ID));
  await db.$client.end();
});

describeIfDb('seed-reward revokeAllSessionsForPlayer race', () => {
  it('leaves no session cache key behind when a session is created during the revoke (#1018)', async () => {
    if (!db) throw new Error('database not configured');
    const lateSessionId = `seed-reward-revoke-late-${PLAYER_ID}`;
    const cache = new Set<string>([`session:${SESSION_A}`]);
    await db.insert(sessions).values({
      id: SESSION_A,
      playerId: PLAYER_ID,
      expiresAt: new Date('2026-08-01T00:00:00.000Z'),
    });
    // A login landing between a pre-read of the session ids and the delete:
    // createSession writes the DB row and the Redis key at the same moment.
    const racingDb = new Proxy(db, {
      get(target, prop, receiver) {
        if (prop !== 'select') return Reflect.get(target, prop, receiver);
        return (...args: unknown[]) => {
          const query = (target.select as (...a: unknown[]) => { from: (t: unknown) => unknown })(
            ...args,
          );
          return {
            from: (table: unknown) => {
              const from = query.from(table) as { where: (w: unknown) => Promise<unknown> };
              return {
                where: async (condition: unknown) => {
                  const rows = await from.where(condition);
                  await target.insert(sessions).values({
                    id: lateSessionId,
                    playerId: PLAYER_ID,
                    expiresAt: new Date('2026-08-01T00:00:00.000Z'),
                  });
                  cache.add(`session:${lateSessionId}`);
                  return rows;
                },
              };
            },
          };
        };
      },
    });
    const redis = {
      del: async (...keys: string[]) => {
        for (const key of keys) cache.delete(key);
        return keys.length;
      },
      publish: async () => 1,
    } as unknown as Pick<Redis, 'del' | 'publish'>;

    await revokeAllSessionsForPlayer(racingDb, redis, PLAYER_ID);

    const remaining = await db
      .select({ id: sessions.id })
      .from(sessions)
      .where(eq(sessions.playerId, PLAYER_ID));
    const staleKeys = [...cache].filter(
      (key) => !remaining.some((row) => key === `session:${row.id}`),
    );
    expect(staleKeys).toEqual([]);
  });
});
