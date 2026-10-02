import { createDatabaseClient, playerNameHistory, players } from '@squad/db';
import { eq } from 'drizzle-orm';
import { afterAll, expect, it } from 'vitest';
import { describeIfDb } from '../../../../packages/db/test/helpers/describe-if.js';
import {
  createPlayerWithHistory,
  isUniqueViolation,
} from '../src/player-identity/create-player.js';

const DATABASE_URL = process.env.DATABASE_URL;

const db = createDatabaseClient(DATABASE_URL ?? 'postgres://unused/unused');
const STEAM = '76561198100009301';

afterAll(async () => {
  await db.delete(players).where(eq(players.steamId64, BigInt(STEAM)));
  await db.$client.end();
});

describeIfDb('createPlayerWithHistory (#908, #919)', () => {
  it('creates the player with its name history, and reports a duplicate as null', async () => {
    const identity = { steamId64: STEAM, eosId: null, name: 'CreatePlayerTest' };
    const id = await createPlayerWithHistory(db, identity, 'test-label');
    expect(id).not.toBeNull();
    const history = await db
      .select()
      .from(playerNameHistory)
      .where(eq(playerNameHistory.playerId, id as string));
    expect(history).toHaveLength(1);

    expect(await createPlayerWithHistory(db, identity, 'test-label')).toBeNull();
  });

  it('rethrows failures that are not unique violations instead of swallowing them', async () => {
    await expect(
      createPlayerWithHistory(db, { steamId64: 'not-a-number', eosId: null, name: 'x' }, 'l'),
    ).rejects.toThrow();
  });

  it('recognises a unique violation wrapped as a cause', () => {
    expect(isUniqueViolation({ cause: { code: '23505' } })).toBe(true);
    expect(isUniqueViolation(new Error('boom'))).toBe(false);
  });
});
