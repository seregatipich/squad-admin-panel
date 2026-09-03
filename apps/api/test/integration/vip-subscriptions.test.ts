import { createHmac, randomUUID } from 'node:crypto';
import {
  adminsCfgSyncOutbox,
  auditLog,
  bonusTransactions,
  economySettings,
  players,
  roles,
  servers,
  vipLifecycleEvents,
  vipSubscriptions,
  vipTiers,
} from '@squad/db/schema';
import { and, eq } from 'drizzle-orm';
import postgres from 'postgres';
import { v7 as uuidv7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ADMINS_CFG_SYNC_STREAM_PREFIX } from '../../src/lib/admins-cfg-sync.js';
import { invalidateAllPermissionCaches } from '../../src/lib/rbac.js';
import { createSession } from '../../src/lib/sessions.js';
import { testSteamId } from '../helpers/snapshot-restore.js';
import {
  assertAuditRow,
  buildIntegrationApp,
  type IntegrationHarness,
  loginAsOwner,
  makeFakeBridge,
} from './harness.js';

const OWNER_STEAM = testSteamId(985001);

const DAY_MS = 86_400_000;
const TIER_PRICE = 100;
const TIER_DAYS = 30;
const VIP_LIFECYCLE_SECRET = 'vip-subscriptions-race-secret-with-enough-entropy';

const describeIfDb = process.env.DATABASE_URL ? describe : describe.skip;

let h: IntegrationHarness;
let ownerCookie: string;

let vipRoleId: string;
let panelRoleId: string;
let otherRoleId: string;
let econOnlyRoleId: string;
let raceRoleId: string;
let serverId: string;

let tierId: string;
let secondTierId: string;
let panelTierId: string;
let unpricedTierId: string;
let inactiveTierId: string;
let raceTierId: string;

let steamCursor = 985010;

function nextSteamOffset(): number {
  steamCursor += 1;
  return steamCursor;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(',')}}`;
}

async function postLifecycle(payload: Record<string, unknown>) {
  const timestamp = new Date().toISOString();
  const signature = `sha256=${createHmac('sha256', VIP_LIFECYCLE_SECRET)
    .update(`${timestamp}.${canonicalJson(payload)}`)
    .digest('hex')}`;
  return h.app.inject({
    method: 'POST',
    url: '/api/v1/integrations/vip/lifecycle',
    headers: {
      'content-type': 'application/json',
      'x-vip-timestamp': timestamp,
      'x-vip-signature': signature,
    },
    payload: JSON.stringify(payload),
  });
}

/**
 * Mints a session the way the BSS callback does for a player whose role has no
 * `panel_access`: scope `self_service`. Anything that is reachable with this
 * cookie is reachable by a plain VIP with no panel rights at all.
 */
async function loginSelfService(playerId: string): Promise<string> {
  invalidateAllPermissionCaches();
  const { token } = await createSession(h.db, h.redis, {
    playerId,
    ip: null,
    userAgent: 'vip-subscriptions-test',
    ttlMs: 21_600_000,
    scope: 'self_service',
  });
  return `__Host-sid=${token}`;
}

async function loginPanel(playerId: string): Promise<string> {
  invalidateAllPermissionCaches();
  const { token } = await createSession(h.db, h.redis, {
    playerId,
    ip: null,
    userAgent: 'vip-subscriptions-test',
    ttlMs: 21_600_000,
  });
  return `__Host-sid=${token}`;
}

async function seedPlayer(
  name: string,
  role: { roleId: string | null; roleExpiresAt?: Date | null } | null = null,
  eosId?: string,
): Promise<string> {
  const [row] = await h.db
    .insert(players)
    .values({
      steamId64: testSteamId(nextSteamOffset()),
      canonicalName: name,
      canonicalNameNormalized: name.toLowerCase(),
      eosId,
      roleId: role?.roleId ?? null,
      roleExpiresAt: role?.roleExpiresAt ?? null,
    })
    .returning({ id: players.id });
  if (!row) throw new Error(`failed to seed player ${name}`);
  return row.id;
}

async function credit(playerId: string, amount: number): Promise<void> {
  const res = await h.app.inject({
    method: 'POST',
    url: `/api/v1/players/${playerId}/bonus-adjustments`,
    headers: { cookie: ownerCookie, 'content-type': 'application/json' },
    payload: JSON.stringify({ amount, comment: 'vip-subscriptions test credit' }),
  });
  if (res.statusCode !== 201) throw new Error(`credit failed: ${res.statusCode} ${res.body}`);
}

async function storedPlayer(playerId: string) {
  const rows = await h.db
    .select({
      balance: players.bonusBalance,
      roleId: players.roleId,
      roleExpiresAt: players.roleExpiresAt,
      roleLifecycleEventId: players.roleLifecycleEventId,
    })
    .from(players)
    .where(eq(players.id, playerId))
    .limit(1);
  const row = rows[0];
  if (!row) throw new Error(`player ${playerId} vanished`);
  return row;
}

async function storedSubscriptions(playerId: string) {
  return h.db.select().from(vipSubscriptions).where(eq(vipSubscriptions.playerId, playerId));
}

function expectCloseTo(actual: Date | null | undefined, expectedMs: number, tolerance = 120_000) {
  expect(actual).toBeTruthy();
  expect(Math.abs((actual as Date).getTime() - expectedMs)).toBeLessThan(tolerance);
}

/**
 * Wraps `real` in a Proxy that recursively re-wraps the result of every method
 * call, so no matter which link of a fluent, thenable query-builder chain the
 * caller finally `await`s, that `await` is the one intercepted: `onSettled`
 * runs after the real query resolves and before the value reaches the caller.
 */
function wrapThenable(real: unknown, onSettled: () => Promise<void>): unknown {
  if (real === null || typeof real !== 'object') return real;
  return new Proxy(real as object, {
    get(target, prop) {
      if (prop === 'then') {
        return (
          onFulfilled?: (value: unknown) => unknown,
          onRejected?: (err: unknown) => unknown,
        ) =>
          Promise.resolve(target as PromiseLike<unknown>).then(async (value: unknown) => {
            await onSettled();
            return onFulfilled ? onFulfilled(value) : value;
          }, onRejected);
      }
      const value = Reflect.get(target, prop, target);
      if (typeof value === 'function') {
        return (...args: unknown[]) =>
          wrapThenable((value as (...a: unknown[]) => unknown).apply(target, args), onSettled);
      }
      return value;
    },
  });
}

/**
 * Runs `body` with the `vip_subscriptions` race window forced open, from inside
 * `createSubscription`'s own `app.db.transaction(async (tx) => {...})`.
 *
 * The naive port of the insert-hook pattern used by `marks.test.ts` and
 * `mark-types.test.ts` — commit the conflicting row from inside the route's own
 * `tx.insert(vipSubscriptions)` call, right before it executes — deadlocks here
 * (verified: the test hangs to its 10s timeout). `createSubscription` calls
 * `applyVipGrant(tx, ...)` before its own insert, which takes `SELECT ... FOR
 * UPDATE` on the player row; `vip_subscriptions_player_id_fkey` makes any insert
 * referencing that player (including the conflicting one, wherever it runs)
 * acquire a `FOR KEY SHARE` lock on the same row, which conflicts with the
 * already-held `FOR UPDATE` and blocks until that transaction ends — which it
 * never does, because it is itself awaiting the (blocked) conflicting insert.
 *
 * Hooking the pre-check `SELECT` instead of the `INSERT` sidesteps this: the
 * conflicting row is committed, on its own connection, immediately after the
 * route's pre-check reports "no active subscription" but strictly before
 * `applyVipGrant` takes its lock, so there is no lock held yet to conflict
 * with. By the time the route reaches its own `tx.insert(vipSubscriptions)`,
 * the conflicting row is already committed, so that insert raises a real
 * `23505` — the same outcome the mirror pattern targets, reached via a hook
 * point this route's own locking makes safe.
 */
async function withRacingDuplicateInsert<T>(
  insertConflictingRow: () => Promise<unknown>,
  body: () => Promise<T>,
): Promise<T> {
  type TxLike = { select: (...args: unknown[]) => unknown };
  const db = h.app.db as unknown as {
    transaction: <R>(fn: (tx: TxLike) => Promise<R>) => Promise<R>;
  };
  const realTransaction = db.transaction.bind(db);
  let fired = false;

  db.transaction = (async (fn: (tx: TxLike) => Promise<unknown>) =>
    realTransaction(async (tx) => {
      const realTxSelect = tx.select.bind(tx);
      tx.select = (...args: unknown[]): unknown => {
        const result = realTxSelect(...args);
        if (fired) return result;
        fired = true;
        return wrapThenable(result, insertConflictingRow);
      };
      return fn(tx);
    })) as typeof db.transaction;

  try {
    return await body();
  } finally {
    db.transaction = realTransaction;
  }
}

async function withPausedInsert<T>(
  table: unknown,
  body: (gate: { waitUntilPaused(): Promise<void>; release(): void }) => Promise<T>,
): Promise<T> {
  type TxLike = { insert: (...args: unknown[]) => unknown };
  const db = h.app.db as unknown as {
    transaction: <R>(fn: (tx: TxLike) => Promise<R>) => Promise<R>;
  };
  const realTransaction = db.transaction.bind(db);
  let paused = false;
  let signalPaused!: () => void;
  let release!: () => void;
  const pausedPromise = new Promise<void>((resolve) => {
    signalPaused = resolve;
  });
  const releasePromise = new Promise<void>((resolve) => {
    release = resolve;
  });

  db.transaction = (async (fn: (tx: TxLike) => Promise<unknown>) =>
    realTransaction(async (tx) => {
      const realInsert = tx.insert.bind(tx);
      tx.insert = (...args: unknown[]): unknown => {
        const query = realInsert(...args);
        if (paused || args[0] !== table) return query;
        paused = true;
        return wrapThenable(query, async () => {
          signalPaused();
          await releasePromise;
        });
      };
      return fn(tx);
    })) as typeof db.transaction;

  try {
    return await body({ waitUntilPaused: () => pausedPromise, release });
  } finally {
    release();
    db.transaction = realTransaction;
  }
}

async function waitForBlockedPlayerLock(): Promise<void> {
  // The harness pool has max=2 and both application transactions occupy it;
  // use a third observer connection so observing the wait cannot itself queue.
  const observer = postgres(h.app.config.DATABASE_URL, { max: 1, prepare: false });
  const deadline = Date.now() + 5_000;
  try {
    while (Date.now() < deadline) {
      const rows = await observer<{ waiting: number }[]>`
        SELECT count(*)::int AS waiting
        FROM pg_stat_activity
        WHERE datname = current_database()
          AND pid <> pg_backend_pid()
          AND wait_event_type = 'Lock'
          AND query ILIKE '%players%FOR UPDATE%'
      `;
      if ((rows[0]?.waiting ?? 0) > 0) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error('losing transaction did not wait for the player row lock');
  } finally {
    await observer.end();
  }
}

async function countOutboxReason(reason: string): Promise<number> {
  const rows = await h.db
    .select({ serverId: adminsCfgSyncOutbox.serverId, payload: adminsCfgSyncOutbox.payload })
    .from(adminsCfgSyncOutbox);
  return rows.filter(
    (row) => row.serverId === serverId && (row.payload as { reason?: string }).reason === reason,
  ).length;
}

async function countSuccessfulAudit(action: string, playerId: string): Promise<number> {
  const rows = await h.db
    .select({ id: auditLog.id })
    .from(auditLog)
    .where(
      and(
        eq(auditLog.actionType, action),
        eq(auditLog.targetId, playerId),
        eq(auditLog.statusCode, 201),
      ),
    );
  return rows.length;
}

beforeAll(async () => {
  h = await buildIntegrationApp({
    seedOwner: { steamId64: OWNER_STEAM, canonicalName: 'SubsOwner' },
    bridge: makeFakeBridge(),
  });
  (h.app.config as Record<string, unknown>).VIP_LIFECYCLE_WEBHOOK_SECRET = VIP_LIFECYCLE_SECRET;
  ownerCookie = await loginAsOwner(h);

  await h.db.update(economySettings).set({ economyEnabled: true }).where(eq(economySettings.id, 1));

  const [srv] = await h.db
    .insert(servers)
    .values({
      id: uuidv7(),
      displayName: 'vip-subscriptions-test-server',
      slug: `vip-subs-${Date.now()}`,
    })
    .returning({ id: servers.id });
  if (!srv) throw new Error('failed to seed server');
  serverId = srv.id;

  vipRoleId = randomUUID();
  panelRoleId = randomUUID();
  otherRoleId = randomUUID();
  econOnlyRoleId = randomUUID();
  raceRoleId = randomUUID();
  await h.db.insert(roles).values([
    { id: vipRoleId, name: 'SubsVip', panelAccess: false },
    { id: panelRoleId, name: 'SubsPanel', panelAccess: true },
    { id: otherRoleId, name: 'SubsOther', panelAccess: false },
    {
      id: econOnlyRoleId,
      name: 'SubsEconOnly',
      panelAccess: true,
      canManageEconomy: true,
      canAssignRoles: false,
    },
    { id: raceRoleId, name: 'SubsExternalRaceVip', panelAccess: false },
  ]);

  const insertTier = async (values: {
    name: string;
    roleId: string;
    defaultDays?: number | null;
    priceBonuses?: number | null;
    isActive?: boolean;
    sortOrder?: number;
  }): Promise<string> => {
    const id = uuidv7();
    await h.db.insert(vipTiers).values({
      id,
      name: values.name,
      roleId: values.roleId,
      defaultDays: values.defaultDays ?? null,
      priceBonuses: values.priceBonuses ?? null,
      isActive: values.isActive ?? true,
      sortOrder: values.sortOrder ?? 0,
    });
    return id;
  };

  tierId = await insertTier({
    name: 'Subs Bronze',
    roleId: vipRoleId,
    defaultDays: TIER_DAYS,
    priceBonuses: TIER_PRICE,
    sortOrder: 10,
  });
  secondTierId = await insertTier({
    name: 'Subs Silver',
    roleId: vipRoleId,
    defaultDays: 7,
    priceBonuses: 40,
    sortOrder: 20,
  });
  panelTierId = await insertTier({
    name: 'Subs PanelTier',
    roleId: panelRoleId,
    defaultDays: TIER_DAYS,
    priceBonuses: 10,
    sortOrder: 30,
  });
  unpricedTierId = await insertTier({
    name: 'Subs Unpriced',
    roleId: vipRoleId,
    defaultDays: TIER_DAYS,
    priceBonuses: null,
    sortOrder: 40,
  });
  inactiveTierId = await insertTier({
    name: 'Subs Inactive',
    roleId: vipRoleId,
    defaultDays: TIER_DAYS,
    priceBonuses: 25,
    isActive: false,
    sortOrder: 50,
  });
  raceTierId = await insertTier({
    name: 'Subs External Race',
    roleId: raceRoleId,
    defaultDays: TIER_DAYS,
    priceBonuses: TIER_PRICE,
    sortOrder: 60,
  });
}, 90_000);

afterAll(async () => {
  await h?.cleanup();
});

describeIfDb('VIPSUB-5 self-service catalog and balance', () => {
  it('serves the purchasable tier catalog to a session without panel access', async () => {
    const playerId = await seedPlayer('SubsCatalogReader');
    const cookie = await loginSelfService(playerId);

    const res = await h.app.inject({ method: 'GET', url: '/api/v1/me/tiers', headers: { cookie } });

    expect(res.statusCode).toBe(200);
    const body = res.json() as { rows: Array<{ tier_id: string; price_bonuses: number }> };
    const ids = body.rows.map((r) => r.tier_id);
    expect(ids).toContain(tierId);
    expect(ids).not.toContain(unpricedTierId);
    expect(ids).not.toContain(inactiveTierId);
    expect(body.rows.find((r) => r.tier_id === tierId)?.price_bonuses).toBe(TIER_PRICE);
  });

  it('serves the own balance and ledger to a session without panel access', async () => {
    const playerId = await seedPlayer('SubsBalanceReader');
    await credit(playerId, 250);
    const cookie = await loginSelfService(playerId);

    const balance = await h.app.inject({
      method: 'GET',
      url: '/api/v1/me/bonus-balance',
      headers: { cookie },
    });
    expect(balance.statusCode).toBe(200);
    expect(balance.json()).toMatchObject({ balance: 250 });

    const history = await h.app.inject({
      method: 'GET',
      url: '/api/v1/me/bonus-transactions',
      headers: { cookie },
    });
    expect(history.statusCode).toBe(200);
    const items = (history.json() as { items: Array<{ amount: number; player_id: string }> }).items;
    expect(items.length).toBeGreaterThan(0);
    for (const item of items) expect(item.player_id).toBe(playerId);
  });

  it('rejects an anonymous request for the self-service catalog', async () => {
    const res = await h.app.inject({ method: 'GET', url: '/api/v1/me/tiers' });
    expect(res.statusCode).toBe(401);
  });
});

describeIfDb('VIPSUB-5 self-service one-off purchase', () => {
  it('spends the price, grants the timed role and enqueues the Admins.cfg sync', async () => {
    const playerId = await seedPlayer('SubsBuyer');
    await credit(playerId, 250);
    const cookie = await loginSelfService(playerId);

    const res = await h.app.inject({
      method: 'POST',
      url: '/api/v1/me/purchases',
      headers: { cookie, 'content-type': 'application/json' },
      payload: JSON.stringify({ tier_id: tierId }),
    });

    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ ok: true, balance: 150, role_id: vipRoleId });

    const stored = await storedPlayer(playerId);
    expect(stored.balance).toBe(150);
    expect(stored.roleId).toBe(vipRoleId);
    expectCloseTo(stored.roleExpiresAt, Date.now() + TIER_DAYS * DAY_MS);

    const ledger = await h.db
      .select()
      .from(bonusTransactions)
      .where(and(eq(bonusTransactions.playerId, playerId), eq(bonusTransactions.type, 'spend')));
    expect(ledger).toHaveLength(1);
    expect(ledger[0]?.amount).toBe(-TIER_PRICE);
    expect(ledger[0]?.referenceId).toBe(tierId);

    const audit = await assertAuditRow(h, { action: 'me.purchase.create' });
    expect(audit.actorPlayerId).toBe(playerId);
  });

  it('refuses a purchase the balance cannot cover and leaves the balance intact', async () => {
    const playerId = await seedPlayer('SubsPoorBuyer');
    await credit(playerId, 10);
    const cookie = await loginSelfService(playerId);

    const res = await h.app.inject({
      method: 'POST',
      url: '/api/v1/me/purchases',
      headers: { cookie, 'content-type': 'application/json' },
      payload: JSON.stringify({ tier_id: tierId }),
    });

    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: 'insufficient_balance', balance: 10 });
    const stored = await storedPlayer(playerId);
    expect(stored.balance).toBe(10);
    expect(stored.roleId).toBeNull();
  });

  it('refuses to sell a tier whose role opens the panel', async () => {
    const playerId = await seedPlayer('SubsEscalationBuyer');
    await credit(playerId, 500);
    const cookie = await loginSelfService(playerId);

    const res = await h.app.inject({
      method: 'POST',
      url: '/api/v1/me/purchases',
      headers: { cookie, 'content-type': 'application/json' },
      payload: JSON.stringify({ tier_id: panelTierId }),
    });

    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ error: 'role_grants_panel_access' });
    expect((await storedPlayer(playerId)).roleId).toBeNull();
  });

  it('refuses a tier that carries no price', async () => {
    const playerId = await seedPlayer('SubsUnpricedBuyer');
    await credit(playerId, 500);
    const cookie = await loginSelfService(playerId);

    const res = await h.app.inject({
      method: 'POST',
      url: '/api/v1/me/purchases',
      headers: { cookie, 'content-type': 'application/json' },
      payload: JSON.stringify({ tier_id: unpricedTierId }),
    });

    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: 'tier_not_purchasable' });
  });

  it('refuses a purchase that would collide with a different role', async () => {
    const playerId = await seedPlayer('SubsConflictBuyer', {
      roleId: otherRoleId,
      roleExpiresAt: new Date(Date.now() + DAY_MS),
    });
    await credit(playerId, 500);
    const cookie = await loginSelfService(playerId);

    const res = await h.app.inject({
      method: 'POST',
      url: '/api/v1/me/purchases',
      headers: { cookie, 'content-type': 'application/json' },
      payload: JSON.stringify({ tier_id: tierId }),
    });

    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: 'role_conflict' });
  });
});

describeIfDb('VIPSUB-5 self-service subscriptions', () => {
  it('subscribes, snapshots the price and schedules the next renewal', async () => {
    const playerId = await seedPlayer('SubsSubscriber');
    await credit(playerId, 250);
    const cookie = await loginSelfService(playerId);

    const res = await h.app.inject({
      method: 'POST',
      url: '/api/v1/me/subscriptions',
      headers: { cookie, 'content-type': 'application/json' },
      payload: JSON.stringify({ tier_id: tierId }),
    });

    expect(res.statusCode).toBe(201);
    const body = res.json() as {
      subscription: {
        id: string;
        status: string;
        price_bonuses: number;
        renews_every_days: number;
        next_renewal_at: string;
      };
      balance: number;
    };
    expect(body.balance).toBe(150);
    expect(body.subscription).toMatchObject({
      status: 'active',
      price_bonuses: TIER_PRICE,
      renews_every_days: TIER_DAYS,
    });
    expectCloseTo(new Date(body.subscription.next_renewal_at), Date.now() + TIER_DAYS * DAY_MS);

    const stored = await storedPlayer(playerId);
    expect(stored.roleId).toBe(vipRoleId);
    expectCloseTo(stored.roleExpiresAt, Date.now() + TIER_DAYS * DAY_MS);

    const audit = await assertAuditRow(h, { action: 'me.subscription.create' });
    expect(audit.actorPlayerId).toBe(playerId);
  });

  it('keeps the snapshot price when the catalog is repriced afterwards', async () => {
    const playerId = await seedPlayer('SubsSnapshot');
    await credit(playerId, 500);
    const cookie = await loginSelfService(playerId);
    const repricedTier = uuidv7();
    await h.db.insert(vipTiers).values({
      id: repricedTier,
      name: `Subs Repriced ${Date.now()}`,
      roleId: vipRoleId,
      defaultDays: 14,
      priceBonuses: 60,
    });

    const res = await h.app.inject({
      method: 'POST',
      url: '/api/v1/me/subscriptions',
      headers: { cookie, 'content-type': 'application/json' },
      payload: JSON.stringify({ tier_id: repricedTier }),
    });
    expect(res.statusCode).toBe(201);

    await h.db
      .update(vipTiers)
      .set({ priceBonuses: 9999, defaultDays: 1 })
      .where(eq(vipTiers.id, repricedTier));

    const [sub] = await storedSubscriptions(playerId);
    expect(sub?.priceBonuses).toBe(60);
    expect(sub?.renewsEveryDays).toBe(14);
  });

  it('rejects a second active subscription for the same player', async () => {
    const playerId = await seedPlayer('SubsDouble');
    await credit(playerId, 500);
    const cookie = await loginSelfService(playerId);

    const first = await h.app.inject({
      method: 'POST',
      url: '/api/v1/me/subscriptions',
      headers: { cookie, 'content-type': 'application/json' },
      payload: JSON.stringify({ tier_id: tierId }),
    });
    expect(first.statusCode).toBe(201);
    const balanceAfterFirst = (await storedPlayer(playerId)).balance;

    const second = await h.app.inject({
      method: 'POST',
      url: '/api/v1/me/subscriptions',
      headers: { cookie, 'content-type': 'application/json' },
      payload: JSON.stringify({ tier_id: secondTierId }),
    });

    expect(second.statusCode).toBe(409);
    expect(second.json()).toMatchObject({ error: 'already_subscribed' });
    expect((await storedPlayer(playerId)).balance).toBe(balanceAfterFirst);
  });

  it('cancelling keeps the paid period: role and expiry are untouched', async () => {
    const playerId = await seedPlayer('SubsCanceller');
    await credit(playerId, 500);
    const cookie = await loginSelfService(playerId);
    const created = await h.app.inject({
      method: 'POST',
      url: '/api/v1/me/subscriptions',
      headers: { cookie, 'content-type': 'application/json' },
      payload: JSON.stringify({ tier_id: tierId }),
    });
    expect(created.statusCode).toBe(201);
    const before = await storedPlayer(playerId);
    const subId = (created.json() as { subscription: { id: string } }).subscription.id;

    const res = await h.app.inject({
      method: 'DELETE',
      url: `/api/v1/me/subscriptions/${subId}`,
      headers: { cookie },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ subscription: { status: 'cancelled' } });

    const after = await storedPlayer(playerId);
    expect(after.roleId).toBe(before.roleId);
    expect(after.roleExpiresAt?.getTime()).toBe(before.roleExpiresAt?.getTime());
    expect(after.balance).toBe(before.balance);

    const [sub] = await storedSubscriptions(playerId);
    expect(sub?.status).toBe('cancelled');
    expect(sub?.cancelledAt).toBeTruthy();

    await assertAuditRow(h, { action: 'me.subscription.cancel', targetId: subId });
  });

  it("refuses to cancel another player's subscription", async () => {
    const victimId = await seedPlayer('SubsVictim');
    await credit(victimId, 500);
    const victimCookie = await loginSelfService(victimId);
    const created = await h.app.inject({
      method: 'POST',
      url: '/api/v1/me/subscriptions',
      headers: { cookie: victimCookie, 'content-type': 'application/json' },
      payload: JSON.stringify({ tier_id: tierId }),
    });
    expect(created.statusCode).toBe(201);
    const subId = (created.json() as { subscription: { id: string } }).subscription.id;

    const attackerId = await seedPlayer('SubsAttacker');
    const attackerCookie = await loginSelfService(attackerId);

    const res = await h.app.inject({
      method: 'DELETE',
      url: `/api/v1/me/subscriptions/${subId}`,
      headers: { cookie: attackerCookie },
    });

    expect(res.statusCode).toBe(404);
    const [sub] = await storedSubscriptions(victimId);
    expect(sub?.status).toBe('active');
  });

  it('lists only the requesting player’s own subscriptions', async () => {
    const mineId = await seedPlayer('SubsMine');
    await credit(mineId, 500);
    const mineCookie = await loginSelfService(mineId);
    await h.app.inject({
      method: 'POST',
      url: '/api/v1/me/subscriptions',
      headers: { cookie: mineCookie, 'content-type': 'application/json' },
      payload: JSON.stringify({ tier_id: tierId }),
    });

    const otherId = await seedPlayer('SubsTheirs');
    const otherCookie = await loginSelfService(otherId);

    const mine = await h.app.inject({
      method: 'GET',
      url: '/api/v1/me/subscriptions',
      headers: { cookie: mineCookie },
    });
    const theirs = await h.app.inject({
      method: 'GET',
      url: '/api/v1/me/subscriptions',
      headers: { cookie: otherCookie },
    });

    expect(mine.statusCode).toBe(200);
    const mineRows = (mine.json() as { rows: Array<{ player_id: string }> }).rows;
    expect(mineRows).toHaveLength(1);
    expect(mineRows[0]?.player_id).toBe(mineId);
    expect((theirs.json() as { rows: unknown[] }).rows).toHaveLength(0);
  });

  it('refuses to subscribe while the economy module is disabled', async () => {
    const playerId = await seedPlayer('SubsEconomyOff');
    await credit(playerId, 500);
    const cookie = await loginSelfService(playerId);
    await h.db
      .update(economySettings)
      .set({ economyEnabled: false })
      .where(eq(economySettings.id, 1));

    try {
      const res = await h.app.inject({
        method: 'POST',
        url: '/api/v1/me/subscriptions',
        headers: { cookie, 'content-type': 'application/json' },
        payload: JSON.stringify({ tier_id: tierId }),
      });
      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ error: 'economy_disabled' });
    } finally {
      await h.db
        .update(economySettings)
        .set({ economyEnabled: true })
        .where(eq(economySettings.id, 1));
    }
  });

  it('returns 409 when a concurrent writer wins the race past the pre-check inside the transaction', async () => {
    const playerId = await seedPlayer('SubsRaceCondition');
    await credit(playerId, 500);
    const cookie = await loginSelfService(playerId);

    const res = await withRacingDuplicateInsert(
      () =>
        h.db.insert(vipSubscriptions).values({
          id: randomUUID(),
          playerId,
          tierId,
          status: 'active',
          renewsEveryDays: TIER_DAYS,
          priceBonuses: TIER_PRICE,
          nextRenewalAt: new Date(Date.now() + TIER_DAYS * DAY_MS),
        }),
      () =>
        h.app.inject({
          method: 'POST',
          url: '/api/v1/me/subscriptions',
          headers: { cookie, 'content-type': 'application/json' },
          payload: JSON.stringify({ tier_id: tierId }),
        }),
    );

    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: 'already_subscribed' });
    expect((await storedPlayer(playerId)).balance).toBe(500);
    expect(await storedSubscriptions(playerId)).toHaveLength(1);
  });

  it('forces the external lifecycle winner in 10 real database interleavings', async () => {
    for (let iteration = 0; iteration < 10; iteration += 1) {
      const playerId = await seedPlayer(
        `SubsExternalRace${iteration}`,
        null,
        `vip-external-wins-${iteration}-${Date.now()}`,
      );
      await credit(playerId, 500);
      const cookie = await loginSelfService(playerId);
      const eventId = `vip-external-wins-${iteration}-${Date.now()}`;
      const outboxBefore = await countOutboxReason('vip.lifecycle.assigned');
      const loserOutboxBefore = await countOutboxReason('player.role.assign');
      const redisBefore = await h.redis.xlen(`${ADMINS_CFG_SYNC_STREAM_PREFIX}${serverId}`);

      const [lifecycle, subscription] = await withPausedInsert(
        vipLifecycleEvents,
        async ({ waitUntilPaused, release }) => {
          const winner = postLifecycle({
            event_id: eventId,
            event_type: 'vip.purchased',
            player_id: playerId,
            role_id: raceRoleId,
            tier: 'tier_1',
            purchase_id: `external-race-${iteration}`,
            expires_at: '2030-01-02T03:04:05.000Z',
          });
          await waitUntilPaused();
          let loserSettled = false;
          const loser = h.app
            .inject({
              method: 'POST',
              url: '/api/v1/me/subscriptions',
              headers: { cookie, 'content-type': 'application/json' },
              payload: JSON.stringify({ tier_id: raceTierId }),
            })
            .then((response) => {
              loserSettled = true;
              return response;
            });
          await waitForBlockedPlayerLock();
          expect(loserSettled).toBe(false);
          release();
          return Promise.all([winner, loser]);
        },
      );

      expect(lifecycle.statusCode).toBe(202);
      expect(subscription.statusCode).toBe(409);
      expect(subscription.json()).toMatchObject({ error: 'vip_lifecycle_owned' });
      expect(await storedSubscriptions(playerId)).toHaveLength(0);
      expect(
        await h.db
          .select({ id: bonusTransactions.id })
          .from(bonusTransactions)
          .where(
            and(eq(bonusTransactions.playerId, playerId), eq(bonusTransactions.type, 'spend')),
          ),
      ).toHaveLength(0);
      expect(await countSuccessfulAudit('me.subscription.create', playerId)).toBe(0);
      expect(await countOutboxReason('vip.lifecycle.assigned')).toBe(outboxBefore + 1);
      expect(await countOutboxReason('player.role.assign')).toBe(loserOutboxBefore);
      expect(await h.redis.xlen(`${ADMINS_CFG_SYNC_STREAM_PREFIX}${serverId}`)).toBe(redisBefore);
      expect(await storedPlayer(playerId)).toMatchObject({
        balance: 500,
        roleId: raceRoleId,
        roleLifecycleEventId: eventId,
      });
    }
  }, 120_000);

  it('forces the internal subscription winner in 10 real database interleavings', async () => {
    for (let iteration = 0; iteration < 10; iteration += 1) {
      const playerId = await seedPlayer(
        `SubsInternalRace${iteration}`,
        null,
        `vip-internal-wins-${iteration}-${Date.now()}`,
      );
      await credit(playerId, 500);
      const cookie = await loginSelfService(playerId);
      const eventId = `vip-internal-loser-${iteration}-${Date.now()}`;
      const outboxBefore = await countOutboxReason('player.role.assign');
      const loserOutboxBefore = await countOutboxReason('vip.lifecycle.assigned');
      const redisBefore = await h.redis.xlen(`${ADMINS_CFG_SYNC_STREAM_PREFIX}${serverId}`);

      const [subscription, lifecycle] = await withPausedInsert(
        vipSubscriptions,
        async ({ waitUntilPaused, release }) => {
          const winner = h.app.inject({
            method: 'POST',
            url: '/api/v1/me/subscriptions',
            headers: { cookie, 'content-type': 'application/json' },
            payload: JSON.stringify({ tier_id: raceTierId }),
          });
          await waitUntilPaused();
          let loserSettled = false;
          const loser = postLifecycle({
            event_id: eventId,
            event_type: 'vip.purchased',
            player_id: playerId,
            role_id: raceRoleId,
            tier: 'tier_1',
            purchase_id: `external-race-${iteration}`,
            expires_at: '2030-01-02T03:04:05.000Z',
          }).then((response) => {
            loserSettled = true;
            return response;
          });
          await waitForBlockedPlayerLock();
          expect(loserSettled).toBe(false);
          release();
          return Promise.all([winner, loser]);
        },
      );

      expect(subscription.statusCode).toBe(201);
      expect(lifecycle.statusCode).toBe(409);
      expect(lifecycle.json()).toEqual({
        error: 'vip_subscription_conflict',
        error_code: 'vip_subscription_conflict',
      });
      expect(await storedSubscriptions(playerId)).toHaveLength(1);
      expect(
        await h.db
          .select({ id: bonusTransactions.id })
          .from(bonusTransactions)
          .where(
            and(eq(bonusTransactions.playerId, playerId), eq(bonusTransactions.type, 'spend')),
          ),
      ).toHaveLength(1);
      expect(
        await h.db
          .select({ id: vipLifecycleEvents.eventId })
          .from(vipLifecycleEvents)
          .where(eq(vipLifecycleEvents.eventId, eventId)),
      ).toHaveLength(0);
      expect(await countSuccessfulAudit('vip.lifecycle.apply', playerId)).toBe(0);
      expect(await countOutboxReason('player.role.assign')).toBe(outboxBefore + 1);
      expect(await countOutboxReason('vip.lifecycle.assigned')).toBe(loserOutboxBefore);
      expect(await h.redis.xlen(`${ADMINS_CFG_SYNC_STREAM_PREFIX}${serverId}`)).toBe(redisBefore);
      expect(await storedPlayer(playerId)).toMatchObject({
        balance: 400,
        roleId: raceRoleId,
        roleLifecycleEventId: null,
      });
    }
  }, 120_000);
});

describeIfDb('VIPSUB-5 admin subscription grant', () => {
  it('grants a subscription from the player card and audits it', async () => {
    const playerId = await seedPlayer('SubsGrantTarget');
    await credit(playerId, 500);

    const res = await h.app.inject({
      method: 'POST',
      url: `/api/v1/players/${playerId}/subscriptions`,
      headers: { cookie: ownerCookie, 'content-type': 'application/json' },
      payload: JSON.stringify({ tier_id: tierId }),
    });

    expect(res.statusCode).toBe(201);
    const [sub] = await storedSubscriptions(playerId);
    expect(sub?.status).toBe('active');
    expect(sub?.priceBonuses).toBe(TIER_PRICE);
    expect((await storedPlayer(playerId)).roleId).toBe(vipRoleId);

    await assertAuditRow(h, { action: 'player.subscription.grant', targetId: playerId });
  });

  it('honours explicit renews_every_days and price_bonuses overrides', async () => {
    const playerId = await seedPlayer('SubsGrantOverride');
    await credit(playerId, 500);

    const res = await h.app.inject({
      method: 'POST',
      url: `/api/v1/players/${playerId}/subscriptions`,
      headers: { cookie: ownerCookie, 'content-type': 'application/json' },
      payload: JSON.stringify({ tier_id: tierId, renews_every_days: 7, price_bonuses: 5 }),
    });

    expect(res.statusCode).toBe(201);
    const [sub] = await storedSubscriptions(playerId);
    expect(sub?.renewsEveryDays).toBe(7);
    expect(sub?.priceBonuses).toBe(5);
    expect((await storedPlayer(playerId)).balance).toBe(495);
  });

  it('refuses an economy manager who cannot assign roles', async () => {
    const adminId = await seedPlayer('SubsEconOnlyAdmin', { roleId: econOnlyRoleId });
    const adminCookie = await loginPanel(adminId);
    const playerId = await seedPlayer('SubsGrantBlocked');
    await credit(playerId, 500);

    const res = await h.app.inject({
      method: 'POST',
      url: `/api/v1/players/${playerId}/subscriptions`,
      headers: { cookie: adminCookie, 'content-type': 'application/json' },
      payload: JSON.stringify({ tier_id: tierId }),
    });

    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ required: 'can_assign_roles' });
    expect(await storedSubscriptions(playerId)).toHaveLength(0);
  });

  it('lists the subscriptions of a player to a panel reader', async () => {
    const playerId = await seedPlayer('SubsListed');
    await credit(playerId, 500);
    await h.app.inject({
      method: 'POST',
      url: `/api/v1/players/${playerId}/subscriptions`,
      headers: { cookie: ownerCookie, 'content-type': 'application/json' },
      payload: JSON.stringify({ tier_id: tierId }),
    });

    const res = await h.app.inject({
      method: 'GET',
      url: `/api/v1/players/${playerId}/subscriptions`,
      headers: { cookie: ownerCookie },
    });

    expect(res.statusCode).toBe(200);
    const rows = (res.json() as { rows: Array<{ tier_name: string; status: string }> }).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 'active', tier_name: 'Subs Bronze' });
  });

  it('enqueues an Admins.cfg sync for every active server on a grant', async () => {
    const playerId = await seedPlayer('SubsGrantSync');
    await credit(playerId, 500);
    const before = await h.redis.xlen(`${ADMINS_CFG_SYNC_STREAM_PREFIX}${serverId}`);

    const res = await h.app.inject({
      method: 'POST',
      url: `/api/v1/players/${playerId}/subscriptions`,
      headers: { cookie: ownerCookie, 'content-type': 'application/json' },
      payload: JSON.stringify({ tier_id: tierId }),
    });
    expect(res.statusCode).toBe(201);

    const outbox = await h.db
      .select({ serverId: adminsCfgSyncOutbox.serverId, payload: adminsCfgSyncOutbox.payload })
      .from(adminsCfgSyncOutbox);
    expect(
      outbox.filter((r) => (r.payload as { reason?: string }).reason === 'player.role.assign')
        .length,
    ).toBeGreaterThan(0);
    expect(await h.redis.xlen(`${ADMINS_CFG_SYNC_STREAM_PREFIX}${serverId}`)).toBe(before);
  });
});
