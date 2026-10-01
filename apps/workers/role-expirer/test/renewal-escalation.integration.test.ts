import { randomUUID } from 'node:crypto';
import {
  auditLog,
  bonusTransactions,
  createDatabaseClient,
  players,
  roles,
  vipSubscriptions,
  vipTiers,
} from '@squad/db';
import { and, eq, inArray } from 'drizzle-orm';
import type Redis from 'ioredis';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { describeIfDb } from '../../../../packages/db/test/helpers/describe-if.js';
import { createSubscriptionRenewalDeps, runSubscriptionRenewalTick } from '../src/renewal.js';

const DATABASE_URL = process.env.DATABASE_URL;

const TIER_PRICE = 100;
const TIER_DAYS = 30;

/** Test SteamIDs for #31 (finding 362), next to the #171 renewal block. */
const PANEL_STEAM = 76561197999985802n;
const SYSTEM_STEAM = 76561197999985803n;

const db = DATABASE_URL ? createDatabaseClient(DATABASE_URL) : null;

/**
 * Each case is a subscription bought on a harmless tier whose tier was then
 * re-pointed at an escalating role (rows written before the API guard, or
 * directly in the database). The subscriber's paid role already lapsed, so
 * `planVipGrant` alone would happily grant the new role on renewal.
 */
const cases = [
  { label: 'panel-access', steam: PANEL_STEAM, role: { panelAccess: true, isSystemRole: false } },
  { label: 'system', steam: SYSTEM_STEAM, role: { panelAccess: false, isSystemRole: true } },
].map((c) => ({
  ...c,
  playerId: randomUUID(),
  roleId: randomUUID(),
  tierId: randomUUID(),
  subscriptionId: randomUUID(),
}));

beforeAll(async () => {
  if (!db) return;
  for (const c of cases) {
    await db.delete(players).where(eq(players.steamId64, c.steam));
    await db.insert(roles).values({ id: c.roleId, name: `RenewalEscalate-${c.roleId}`, ...c.role });
    await db.insert(vipTiers).values({
      id: c.tierId,
      name: `Renewal Escalate ${c.tierId}`,
      roleId: c.roleId,
      defaultDays: TIER_DAYS,
      priceBonuses: TIER_PRICE,
    });
    await db.insert(players).values({
      id: c.playerId,
      steamId64: c.steam,
      canonicalName: `RenewalEscalate-${c.label}`,
      canonicalNameNormalized: `renewalescalate-${c.label}`,
      bonusBalance: 500,
      roleId: null,
      roleExpiresAt: null,
    });
    await db.insert(vipSubscriptions).values({
      id: c.subscriptionId,
      playerId: c.playerId,
      tierId: c.tierId,
      status: 'active',
      renewsEveryDays: TIER_DAYS,
      priceBonuses: TIER_PRICE,
      nextRenewalAt: new Date(Date.now() - 60_000),
    });
  }
});

afterAll(async () => {
  if (!db) return;
  const tierIds = cases.map((c) => c.tierId);
  await db.delete(vipSubscriptions).where(inArray(vipSubscriptions.tierId, tierIds));
  for (const c of cases) {
    await db.delete(bonusTransactions).where(eq(bonusTransactions.playerId, c.playerId));
    await db.delete(players).where(eq(players.steamId64, c.steam));
  }
  await db.delete(vipTiers).where(inArray(vipTiers.id, tierIds));
  await db.delete(roles).where(
    inArray(
      roles.id,
      cases.map((c) => c.roleId),
    ),
  );
  await db.$client.end();
});

describeIfDb('runSubscriptionRenewalTick escalation guard (#31)', () => {
  it('ends a subscription whose tier now maps to a panel-access or system role without granting it', async () => {
    if (!db) return;
    const redis = { publish: vi.fn(async () => 1) } as unknown as Pick<Redis, 'publish'>;
    await runSubscriptionRenewalTick({
      ...createSubscriptionRenewalDeps(db, redis),
      diag: { emit: vi.fn(async () => undefined) },
    });

    for (const c of cases) {
      const [player] = await db
        .select({ roleId: players.roleId, balance: players.bonusBalance })
        .from(players)
        .where(eq(players.id, c.playerId));
      expect(player, c.label).toEqual({ roleId: null, balance: 500 });

      const [subscription] = await db
        .select({ status: vipSubscriptions.status })
        .from(vipSubscriptions)
        .where(eq(vipSubscriptions.id, c.subscriptionId));
      expect(subscription?.status, c.label).toBe('expired');

      const spends = await db
        .select()
        .from(bonusTransactions)
        .where(eq(bonusTransactions.playerId, c.playerId));
      expect(spends, c.label).toHaveLength(0);

      const [expireAudit] = await db
        .select({ context: auditLog.context })
        .from(auditLog)
        .where(
          and(
            eq(auditLog.targetId, c.playerId),
            eq(auditLog.actionType, 'player.subscription.expire'),
          ),
        );
      expect(expireAudit?.context, c.label).toMatchObject({ reason: 'role_grants_panel_access' });
    }
  }, 60_000);
});
