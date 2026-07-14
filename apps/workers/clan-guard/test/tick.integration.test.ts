import {
  auditLog,
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
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createClanGuardDeps } from '../src/deps.js';
import { runClanGuardTick } from '../src/tick.js';

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error('DATABASE_URL must point at the clan-guard test database');

const db = createDatabaseClient(DATABASE_URL);
const SERVER_ID = uuidv7();
const CLAN_ID = uuidv7();
const PLAYER_ID = uuidv7();
const PLAYER_STEAM_ID = 76561198910000091n;
const PLAYER_EOS_ID = '91919191919191919191919191919191';
const CONNECTED_AT = new Date();
const MESSAGE = 'Тег [91] защищён кланом Защитники. Смените ник.';

function makeRedis(): Pick<Redis, 'xadd'> {
  return { xadd: vi.fn(async () => 'stream-id') } as unknown as Pick<Redis, 'xadd'>;
}

beforeAll(async () => {
  await db.insert(servers).values({
    id: SERVER_ID,
    displayName: 'Сервер проверки защиты тега',
    slug: `clan-guard-audit-${SERVER_ID.slice(0, 8)}`,
  });
  await db.insert(clans).values({
    id: CLAN_ID,
    name: 'Защитники',
    tags: ['[91]'],
    isTagProtected: true,
  });
  await db.insert(players).values({
    id: PLAYER_ID,
    steamId64: PLAYER_STEAM_ID,
    canonicalName: '[91] Самозванец',
    canonicalNameNormalized: '[91] самозванец',
    eosId: PLAYER_EOS_ID,
  });
  await db.insert(playerSessions).values({
    playerId: PLAYER_ID,
    serverId: SERVER_ID,
    connectedAt: CONNECTED_AT,
    mode: 'online',
  });
});

afterAll(async () => {
  await db.delete(moderationActions).where(eq(moderationActions.serverId, SERVER_ID));
  await db.delete(playerSessions).where(eq(playerSessions.serverId, SERVER_ID));
  await db.delete(clans).where(eq(clans.id, CLAN_ID));
  await db.delete(players).where(eq(players.steamId64, PLAYER_STEAM_ID));
  await db.delete(servers).where(eq(servers.id, SERVER_ID));
  await db.$client.end();
});

describe('clan-guard audit integration', () => {
  it('writes one audit row for the warn and another for the subsequent kick', async () => {
    const redis = makeRedis();
    const deps = createClanGuardDeps(db, redis);
    const diag = { emit: vi.fn().mockResolvedValue(undefined) };

    const warnResult = await runClanGuardTick({ ...deps, now: CONNECTED_AT, diag });
    expect(warnResult).toEqual({ skipped: false, warned: 1, kicked: 0, errors: 0 });

    const warnActions = await db
      .select()
      .from(moderationActions)
      .where(
        and(
          eq(moderationActions.playerId, PLAYER_ID),
          eq(moderationActions.actionType, 'clan_tag_protection'),
        ),
      );
    expect(warnActions).toHaveLength(1);
    expect(warnActions[0]).toMatchObject({
      serverId: SERVER_ID,
      authorSystemLabel: 'clan-guard',
      reason: MESSAGE,
      context: {
        phase: 'warn',
        clan_id: CLAN_ID,
        tag: '[91]',
        matched_name: '[91] Самозванец',
      },
    });

    const warnAuditRows = await db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.targetType, 'player'),
          eq(auditLog.targetId, PLAYER_ID),
          eq(auditLog.actionType, 'clan.tag_protection.warn'),
        ),
      );
    expect(warnAuditRows).toHaveLength(1);
    expect(warnAuditRows[0]).toMatchObject({
      actorKind: 'system',
      actorPlayerId: null,
      actorTokenId: null,
      actorSystemLabel: 'clan-guard',
      actionType: 'clan.tag_protection.warn',
      targetType: 'player',
      targetId: PLAYER_ID,
      context: { server_id: SERVER_ID, clan_id: CLAN_ID, message: MESSAGE },
    });

    const kickResult = await runClanGuardTick({
      ...deps,
      now: new Date(CONNECTED_AT.getTime() + 301_000),
      diag,
    });
    expect(kickResult).toEqual({ skipped: false, warned: 0, kicked: 1, errors: 0 });

    const actions = await db
      .select({ context: moderationActions.context })
      .from(moderationActions)
      .where(
        and(
          eq(moderationActions.playerId, PLAYER_ID),
          eq(moderationActions.actionType, 'clan_tag_protection'),
        ),
      );
    expect(actions).toHaveLength(2);
    expect(actions.map((row) => row.context)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ phase: 'warn' }),
        expect.objectContaining({ phase: 'kick' }),
      ]),
    );

    const auditRows = await db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.targetType, 'player'),
          eq(auditLog.targetId, PLAYER_ID),
          inArray(auditLog.actionType, ['clan.tag_protection.warn', 'clan.tag_protection.kick']),
        ),
      );
    expect(auditRows).toHaveLength(2);
    expect(auditRows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ actionType: 'clan.tag_protection.warn' }),
        expect.objectContaining({
          actorKind: 'system',
          actorSystemLabel: 'clan-guard',
          actionType: 'clan.tag_protection.kick',
          targetType: 'player',
          targetId: PLAYER_ID,
          context: { server_id: SERVER_ID, clan_id: CLAN_ID, message: MESSAGE },
        }),
      ]),
    );
  });
});
