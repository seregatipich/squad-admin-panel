import { randomUUID } from 'node:crypto';
import { createDatabaseClient, players, sessions } from '@squad/db';
import { eq } from 'drizzle-orm';
import type Redis from 'ioredis';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { revokeAllSessionsForPlayer } from '../src/tick.js';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;

const PLAYER_ID = randomUUID();
const PLAYER_STEAM_ID = 76561198914200077n;
const SESSION_A = `role-expirer-revoke-${PLAYER_ID}-a`;
const SESSION_B = `role-expirer-revoke-${PLAYER_ID}-b`;

const db = DATABASE_URL ? createDatabaseClient(DATABASE_URL) : null;

function makeRedis(): {
  redis: Pick<Redis, 'del' | 'publish'>;
  del: ReturnType<typeof vi.fn>;
  publish: ReturnType<typeof vi.fn>;
} {
  const del = vi.fn(async () => 1);
  const publish = vi.fn(async () => 1);
  return {
    redis: { del, publish } as unknown as Pick<Redis, 'del' | 'publish'>,
    del,
    publish,
  };
}

function revokedFor(
  publish: ReturnType<typeof vi.fn>,
): Array<{ playerId: string; sessionId: string }> {
  return publish.mock.calls
    .filter(([channel]) => channel === 'live-bus')
    .map(([, raw]) => JSON.parse(raw as string) as { type: string; data: Record<string, string> })
    .filter((evt) => evt.type === 'session.revoked')
    .map((evt) => ({ playerId: evt.data.player_id, sessionId: evt.data.session_id }));
}

beforeAll(async () => {
  if (!db) return;
  await db.insert(players).values({
    id: PLAYER_ID,
    steamId64: PLAYER_STEAM_ID,
    canonicalName: 'Истекающий модератор',
    canonicalNameNormalized: 'истекающий модератор',
  });
});

afterAll(async () => {
  if (!db) return;
  await db.delete(sessions).where(eq(sessions.playerId, PLAYER_ID));
  await db.delete(players).where(eq(players.steamId64, PLAYER_STEAM_ID));
  await db.$client.end();
});

describeIfDb('role-expirer revokeAllSessionsForPlayer', () => {
  it('deletes all sessions and pushes a session.revoked per session to the live bus', async () => {
    if (!db) throw new Error('database not configured');
    // Created here rather than in beforeAll, so the no-sessions test cannot
    // revoke them first when the order changes.
    await db.insert(sessions).values([
      { id: SESSION_A, playerId: PLAYER_ID, expiresAt: new Date('2026-08-01T00:00:00.000Z') },
      { id: SESSION_B, playerId: PLAYER_ID, expiresAt: new Date('2026-08-01T00:00:00.000Z') },
    ]);
    const { redis, del, publish } = makeRedis();

    await revokeAllSessionsForPlayer(db, redis, PLAYER_ID);

    // Sessions gone from the DB (forced logout on the server side).
    const remaining = await db
      .select({ id: sessions.id })
      .from(sessions)
      .where(eq(sessions.playerId, PLAYER_ID));
    expect(remaining).toHaveLength(0);

    // Redis cache keys cleared.
    expect(del).toHaveBeenCalledWith(`session:${SESSION_A}`, `session:${SESSION_B}`);

    // One forced-logout push per revoked session, targeted by player_id.
    const revoked = revokedFor(publish);
    expect(revoked).toContainEqual({ playerId: PLAYER_ID, sessionId: SESSION_A });
    expect(revoked).toContainEqual({ playerId: PLAYER_ID, sessionId: SESSION_B });
    expect(revoked).toHaveLength(2);
  });

  it('does nothing and publishes nothing when the player has no sessions', async () => {
    if (!db) throw new Error('database not configured');
    const { redis, del, publish } = makeRedis();

    await revokeAllSessionsForPlayer(db, redis, PLAYER_ID);

    expect(del).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
  });
});
