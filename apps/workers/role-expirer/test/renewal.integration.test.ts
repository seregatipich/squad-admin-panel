import { randomUUID } from 'node:crypto';
import {
  adminsCfgSyncOutbox,
  alertEvents,
  auditLog,
  bonusTransactions,
  createDatabaseClient,
  players,
  roles,
  servers,
  vipSubscriptions,
  vipTiers,
} from '@squad/db';
import { and, eq, sql } from 'drizzle-orm';
import type Redis from 'ioredis';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createSubscriptionRenewalDeps, runSubscriptionRenewalTick } from '../src/renewal.js';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;

const DAY_MS = 86_400_000;
const TIER_PRICE = 100;
const TIER_DAYS = 30;

/** Reserved test SteamID block for #171 (see the batch plan). */
const RICH_STEAM = 76561197999985800n;
const POOR_STEAM = 76561197999985801n;

const db = DATABASE_URL ? createDatabaseClient(DATABASE_URL) : null;

const richPlayerId = randomUUID();
const poorPlayerId = randomUUID();
const vipRoleId = randomUUID();
const tierId = randomUUID();
const richSubId = randomUUID();
const poorSubId = randomUUID();
const renewalServerId = randomUUID();
const tickNow = new Date(Date.now() + Number.parseInt(randomUUID().slice(0, 8), 16));
const renewalRequestId = `role-expirer:renewals:${tickNow.toISOString()}`;

function makeRedis() {
  const publish = vi.fn(async () => 1);
  return {
    redis: { publish } as unknown as Pick<Redis, 'publish'>,
    publish,
  };
}

const diag = { emit: vi.fn(async () => undefined) };

beforeAll(async () => {
  if (!db) return;
  // afterAll cleans these up, but a run killed mid-way (CI cancellation, a sibling
  // dropping the shared template) leaves the player rows behind, and the next run
  // then dies on players_steam_id64_unique_idx before reaching its first assertion.
  // Make setup idempotent so a crashed predecessor cannot wedge the suite.
  await db.delete(players).where(eq(players.steamId64, RICH_STEAM));
  await db.delete(players).where(eq(players.steamId64, POOR_STEAM));
  await db.insert(roles).values({ id: vipRoleId, name: `RenewalVip-${vipRoleId}` });
  await db.insert(vipTiers).values({
    id: tierId,
    name: `Renewal Tier ${tierId}`,
    roleId: vipRoleId,
    defaultDays: TIER_DAYS,
    priceBonuses: TIER_PRICE,
  });
  await db.insert(servers).values({
    id: renewalServerId,
    displayName: 'Renewal outbox server',
    slug: `renewal-outbox-${renewalServerId}`,
  });

  const dueAt = new Date(Date.now() - 60_000);
  const currentExpiry = new Date(Date.now() + 2 * DAY_MS);

  await db.insert(players).values([
    {
      id: richPlayerId,
      steamId64: RICH_STEAM,
      canonicalName: 'RenewalRich',
      canonicalNameNormalized: 'renewalrich',
      bonusBalance: 500,
      roleId: vipRoleId,
      roleExpiresAt: currentExpiry,
    },
    {
      id: poorPlayerId,
      steamId64: POOR_STEAM,
      canonicalName: 'RenewalPoor',
      canonicalNameNormalized: 'renewalpoor',
      bonusBalance: 5,
      roleId: vipRoleId,
      roleExpiresAt: currentExpiry,
    },
  ]);

  await db.insert(vipSubscriptions).values([
    {
      id: richSubId,
      playerId: richPlayerId,
      tierId,
      status: 'active',
      renewsEveryDays: TIER_DAYS,
      priceBonuses: TIER_PRICE,
      nextRenewalAt: dueAt,
    },
    {
      id: poorSubId,
      playerId: poorPlayerId,
      tierId,
      status: 'active',
      renewsEveryDays: TIER_DAYS,
      priceBonuses: TIER_PRICE,
      nextRenewalAt: dueAt,
    },
  ]);
});

afterAll(async () => {
  if (!db) return;
  await db
    .delete(adminsCfgSyncOutbox)
    .where(sql`${adminsCfgSyncOutbox.payload}->>'request_id' = ${renewalRequestId}`);
  await db.delete(alertEvents).where(sql`payload->>'subscription_id' = ${poorSubId}`);
  await db.delete(vipSubscriptions).where(eq(vipSubscriptions.tierId, tierId));
  await db.delete(bonusTransactions).where(eq(bonusTransactions.playerId, richPlayerId));
  await db.delete(bonusTransactions).where(eq(bonusTransactions.playerId, poorPlayerId));
  // `audit_log` is append-only — a DB trigger denies DELETE. The rows this test
  // writes are scoped to its own throwaway player ids and are left in place.
  await db.delete(players).where(eq(players.steamId64, RICH_STEAM));
  await db.delete(players).where(eq(players.steamId64, POOR_STEAM));
  await db.delete(servers).where(eq(servers.id, renewalServerId));
  await db.delete(vipTiers).where(eq(vipTiers.id, tierId));
  await db.delete(roles).where(eq(roles.id, vipRoleId));
  await db.$client.end();
});

describeIfDb('runSubscriptionRenewalTick against a real database', () => {
  it('renews the funded subscription and expires the unfunded one in a single pass, then does nothing on a second pass', async () => {
    if (!db) return;
    const { redis, publish } = makeRedis();
    const deps = createSubscriptionRenewalDeps(db, redis);
    const activeServerIds = (
      await db.select({ id: servers.id }).from(servers).where(sql`${servers.deletedAt} IS NULL`)
    ).map((row) => row.id);

    const result = await runSubscriptionRenewalTick({ ...deps, now: tickNow, diag });

    expect(result.renewed).toBeGreaterThanOrEqual(1);
    expect(result.expired).toBeGreaterThanOrEqual(1);
    const syncRows = await db
      .select({ serverId: adminsCfgSyncOutbox.serverId })
      .from(adminsCfgSyncOutbox)
      .where(sql`${adminsCfgSyncOutbox.payload}->>'request_id' = ${renewalRequestId}`);
    expect(syncRows).toHaveLength(activeServerIds.length * result.renewed);
    const rowsPerServer = new Map<string, number>();
    for (const row of syncRows) {
      rowsPerServer.set(row.serverId, (rowsPerServer.get(row.serverId) ?? 0) + 1);
    }
    expect(rowsPerServer).toEqual(
      new Map(activeServerIds.map((serverId) => [serverId, result.renewed])),
    );

    // Funded: charged, role extended, schedule advanced, still active.
    const [rich] = await db
      .select({
        balance: players.bonusBalance,
        roleExpiresAt: players.roleExpiresAt,
      })
      .from(players)
      .where(eq(players.id, richPlayerId));
    expect(rich?.balance).toBe(500 - TIER_PRICE);
    expect(rich?.roleExpiresAt?.getTime()).toBeGreaterThan(Date.now() + 30 * DAY_MS);

    const [richSub] = await db
      .select()
      .from(vipSubscriptions)
      .where(eq(vipSubscriptions.id, richSubId));
    expect(richSub?.status).toBe('active');
    expect(richSub?.nextRenewalAt.getTime()).toBeGreaterThan(Date.now() + 29 * DAY_MS);

    const spends = await db
      .select()
      .from(bonusTransactions)
      .where(
        and(eq(bonusTransactions.playerId, richPlayerId), eq(bonusTransactions.type, 'spend')),
      );
    expect(spends).toHaveLength(1);
    expect(spends[0]?.amount).toBe(-TIER_PRICE);
    expect(spends[0]?.referenceId).toBe(richSubId);

    const renewAudit = await db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.targetId, richPlayerId),
          eq(auditLog.actionType, 'player.subscription.renew'),
        ),
      );
    expect(renewAudit).toHaveLength(1);

    // Unfunded: expired, balance untouched, paid period NOT clawed back.
    const [poorSub] = await db
      .select()
      .from(vipSubscriptions)
      .where(eq(vipSubscriptions.id, poorSubId));
    expect(poorSub?.status).toBe('expired');

    const [poor] = await db
      .select({ balance: players.bonusBalance, roleId: players.roleId })
      .from(players)
      .where(eq(players.id, poorPlayerId));
    expect(poor?.balance).toBe(5);
    expect(poor?.roleId).toBe(vipRoleId);

    const expireAudit = await db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.targetId, poorPlayerId),
          eq(auditLog.actionType, 'player.subscription.expire'),
        ),
      );
    expect(expireAudit).toHaveLength(1);

    // The player is notified over the real VIPSUB-4 channel, not a stub.
    const frames = publish.mock.calls
      .filter(([channel]) => channel === 'live-bus')
      .map(
        ([, raw]) => JSON.parse(raw as string) as { type: string; data: { event_kind: string } },
      );
    expect(
      frames.some(
        (f) => f.type === 'alert.triggered' && f.data.event_kind === 'subscription_expired',
      ),
    ).toBe(true);

    // The second pass belongs to this scenario rather than to a test of its
    // own: on its own it depended on running after this one, which a shuffled
    // order does not guarantee. Nothing is due any more, so nothing is charged
    // twice.
    const secondPass = await runSubscriptionRenewalTick({
      ...createSubscriptionRenewalDeps(db, makeRedis().redis),
      diag,
    });
    expect(secondPass).toEqual({ renewed: 0, expired: 0, enqueued: 0 });
    const spendsAfterSecondPass = await db
      .select()
      .from(bonusTransactions)
      .where(
        and(eq(bonusTransactions.playerId, richPlayerId), eq(bonusTransactions.type, 'spend')),
      );
    expect(spendsAfterSecondPass).toHaveLength(1);
  }, 60_000);
});
