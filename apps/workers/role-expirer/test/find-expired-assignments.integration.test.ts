import { randomInt, randomUUID } from 'node:crypto';
import { createDatabaseClient, players, roles } from '@squad/db';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { findExpiredAssignments } from '../src/tick.js';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;

const db = DATABASE_URL ? createDatabaseClient(DATABASE_URL) : null;

const NORMAL_ROLE_ID = randomUUID();
const NORMAL_PLAYER_ID = randomUUID();
const NORMAL_PLAYER_STEAM_ID = 76561198914300000n + BigInt(randomInt(1, 1_000_000));
const OWNER_PLAYER_ID = randomUUID();
const OWNER_PLAYER_STEAM_ID = 76561198914400000n + BigInt(randomInt(1, 1_000_000));

const EXPIRED_AT = new Date('2026-07-06T09:59:00.000Z');
const NOW = new Date('2026-07-06T10:00:00.000Z');

beforeAll(async () => {
  if (!db) return;
  const [ownerRole] = await db
    .select({ id: roles.id })
    .from(roles)
    .where(and(eq(roles.name, 'Owner'), eq(roles.isSystemRole, true)))
    .limit(1);
  if (!ownerRole) throw new Error('Owner role not found — run migrations first');

  await db.insert(roles).values({ id: NORMAL_ROLE_ID, name: `RoleExpirerFind-${NORMAL_ROLE_ID}` });
  await db.insert(players).values([
    {
      id: NORMAL_PLAYER_ID,
      steamId64: NORMAL_PLAYER_STEAM_ID,
      canonicalName: 'Истекший модератор',
      canonicalNameNormalized: 'истекший модератор',
      roleId: NORMAL_ROLE_ID,
      roleExpiresAt: EXPIRED_AT,
    },
    {
      id: OWNER_PLAYER_ID,
      steamId64: OWNER_PLAYER_STEAM_ID,
      canonicalName: 'Истекший владелец',
      canonicalNameNormalized: 'истекший владелец',
      roleId: ownerRole.id,
      roleExpiresAt: EXPIRED_AT,
    },
  ]);
});

afterAll(async () => {
  if (!db) return;
  await db.delete(players).where(eq(players.steamId64, NORMAL_PLAYER_STEAM_ID));
  // OWNER_PLAYER_STEAM_ID is intentionally never deleted: this suite runs
  // against the shared DATABASE_URL used by test:cov's concurrent packages,
  // so whether it is the last remaining Owner at cleanup time depends on
  // that shared state — migration 0107's guard trigger rejects deleting the
  // last Owner. Harmless to leave behind in CI's disposable service container.
  await db.delete(roles).where(eq(roles.id, NORMAL_ROLE_ID));
  await db.$client.end();
});

describeIfDb('findExpiredAssignments against a real database', () => {
  it('never treats an expired Owner role assignment as eligible for expiry', async () => {
    if (!db) throw new Error('database not configured');
    const expired = await findExpiredAssignments(db, NOW, 1000);
    const byPlayerId = new Map(expired.map((row) => [row.playerId, row]));

    expect(byPlayerId.has(NORMAL_PLAYER_ID)).toBe(true);
    expect(byPlayerId.has(OWNER_PLAYER_ID)).toBe(false);
  });
});
