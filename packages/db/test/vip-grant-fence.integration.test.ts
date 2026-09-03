import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabaseClient } from '../src/client.js';
import { applyVipGrant } from '../src/economy/vip-grant.js';
import { panelMeta, players, roles, vipTiers } from '../src/schema/index.js';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;
const ROLE_ID = randomUUID();
const TIER_ID = randomUUID();
const PLAYER_ID = randomUUID();
const PLAYER_STEAM = 76561197999881001n;

class RollbackFenceTest extends Error {}

describeIfDb('applyVipGrant под durable VIP fence', () => {
  const db = DATABASE_URL ? createDatabaseClient(DATABASE_URL) : null;

  beforeAll(async () => {
    if (!db) return;
    await db.delete(players).where(eq(players.steamId64, PLAYER_STEAM));
    await db.insert(roles).values({ id: ROLE_ID, name: `VIP fence grant ${ROLE_ID}` });
    await db.insert(vipTiers).values({
      id: TIER_ID,
      name: `VIP fence grant tier ${TIER_ID}`,
      roleId: ROLE_ID,
      defaultDays: 30,
      priceBonuses: 100,
    });
    await db.insert(players).values({
      id: PLAYER_ID,
      steamId64: PLAYER_STEAM,
      canonicalName: 'VIP fence grant player',
      canonicalNameNormalized: 'vip fence grant player',
      bonusBalance: 500,
    });
  });

  afterAll(async () => {
    if (!db) return;
    await db.delete(players).where(eq(players.steamId64, PLAYER_STEAM));
    await db.delete(vipTiers).where(eq(vipTiers.id, TIER_ID));
    await db.delete(roles).where(eq(roles.id, ROLE_ID));
    await db.$client.end();
  });

  it('returns a stable refusal without charging when strict mode owns the tier role', async () => {
    if (!db) throw new Error('DATABASE_URL is required');
    let result: Awaited<ReturnType<typeof applyVipGrant>> | undefined;
    try {
      await db.transaction(async (tx) => {
        await tx.update(panelMeta).set({ vipLifecycleStrict: true }).where(eq(panelMeta.id, 1));
        result = await applyVipGrant(tx, {
          playerId: PLAYER_ID,
          tier: { roleId: ROLE_ID, days: 30, price: 100 },
          actorPlayerId: null,
          referenceType: 'vip_subscription',
          referenceId: TIER_ID,
        });
        throw new RollbackFenceTest();
      });
    } catch (error) {
      if (!(error instanceof RollbackFenceTest)) throw error;
    }

    expect(result).toEqual({ status: 'vip_lifecycle_required' });
    const [stored] = await db
      .select({ balance: players.bonusBalance, roleId: players.roleId })
      .from(players)
      .where(eq(players.steamId64, PLAYER_STEAM));
    expect(stored).toEqual({ balance: 500, roleId: null });
  });
});
