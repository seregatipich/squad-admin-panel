import {
  clans,
  createDatabaseClient,
  moderationActions,
  playerSessions,
  players,
  servers,
} from '@squad/db';
import { and, eq, inArray } from 'drizzle-orm';
import type Redis from 'ioredis';
import { v7 as uuidv7 } from 'uuid';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { describeIfDb } from '../../../../packages/db/test/helpers/describe-if.js';
import { createClanGuardDeps } from '../src/deps.js';
import { runClanGuardTick } from '../src/tick.js';

const DATABASE_URL = process.env.DATABASE_URL;

const db = createDatabaseClient(DATABASE_URL ?? 'postgres://unused/unused');
const SERVER_ID = uuidv7();
const CLAN_ID = uuidv7();
const CLAN_TAG = 'Q17';
const CONNECTED_AT = new Date();

const INNOCENT = {
  id: uuidv7(),
  steamId64: 76561198910001701n,
  name: 'Q17rush',
  eosId: '17171717171717171717171717171701',
};
const IMPOSTOR = {
  id: uuidv7(),
  steamId64: 76561198910001702n,
  name: 'Q17 Самозванец',
  eosId: '17171717171717171717171717171702',
};
const TEST_PLAYERS = [INNOCENT, IMPOSTOR];

function makeRedis(): Pick<Redis, 'xadd'> {
  return { xadd: vi.fn(async () => 'stream-id') } as unknown as Pick<Redis, 'xadd'>;
}

beforeAll(async () => {
  await db.insert(servers).values({
    id: SERVER_ID,
    displayName: 'Сервер проверки голого тега',
    slug: `clan-guard-bare-${SERVER_ID.slice(0, 8)}`,
  });
  await db.insert(clans).values({
    id: CLAN_ID,
    name: 'Голый тег',
    tags: [CLAN_TAG],
    isTagProtected: true,
  });
  await db.insert(players).values(
    TEST_PLAYERS.map((player) => ({
      id: player.id,
      steamId64: player.steamId64,
      canonicalName: player.name,
      canonicalNameNormalized: player.name.toLowerCase(),
      eosId: player.eosId,
    })),
  );
  await db.insert(playerSessions).values(
    TEST_PLAYERS.map((player) => ({
      playerId: player.id,
      serverId: SERVER_ID,
      connectedAt: CONNECTED_AT,
      mode: 'online' as const,
    })),
  );
});

afterAll(async () => {
  await db.delete(moderationActions).where(eq(moderationActions.serverId, SERVER_ID));
  await db.delete(playerSessions).where(eq(playerSessions.serverId, SERVER_ID));
  await db.delete(clans).where(eq(clans.id, CLAN_ID));
  await db.delete(players).where(
    inArray(
      players.steamId64,
      TEST_PLAYERS.map((player) => player.steamId64),
    ),
  );
  await db.delete(servers).where(eq(servers.id, SERVER_ID));
  await db.$client.end();
});

async function clanGuardActionsFor(playerId: string) {
  return db
    .select({ context: moderationActions.context })
    .from(moderationActions)
    .where(
      and(
        eq(moderationActions.playerId, playerId),
        eq(moderationActions.actionType, 'clan_tag_protection'),
      ),
    );
}

describeIfDb('clan-guard bare tag integration (#17)', () => {
  it('warns a player wearing the bare tag as a word but not one whose nick merely starts with it', async () => {
    const deps = createClanGuardDeps(db, makeRedis());
    const diag = { emit: vi.fn().mockResolvedValue(undefined) };

    const result = await runClanGuardTick({ ...deps, now: CONNECTED_AT, diag });
    expect(result.skipped).toBe(false);
    expect(result.errors).toBe(0);

    expect(await clanGuardActionsFor(INNOCENT.id)).toHaveLength(0);

    const impostorActions = await clanGuardActionsFor(IMPOSTOR.id);
    expect(impostorActions).toHaveLength(1);
    expect(impostorActions[0]?.context).toMatchObject({
      phase: 'warn',
      clan_id: CLAN_ID,
      tag: CLAN_TAG,
      matched_name: IMPOSTOR.name,
    });
  });
});
