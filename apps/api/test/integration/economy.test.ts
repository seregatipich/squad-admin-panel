import { randomUUID } from 'node:crypto';
import { bonusTransactions, players, roles } from '@squad/db/schema';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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

const OWNER_STEAM = testSteamId(820001);
const NO_PANEL_STEAM = testSteamId(820002);
const ADMIN_STEAM = testSteamId(820003);
const ECON_MANAGER_STEAM = testSteamId(820004);
const ROLE_EDITOR_STEAM = testSteamId(820005);
const EOS_ONLY_EOS = 'eos-econ1-000000000000000000000001';

let h: IntegrationHarness;
let ownerCookie: string;
let noPanelCookie: string;
let adminCookie: string;
let econManagerCookie: string;
let roleEditorCookie: string;
let balancePlayerId: string;
let reconPlayerId: string;
let pagePlayerId: string;
let datePlayerId: string;
let eosPlayerId: string;

const describeIfDb = process.env.DATABASE_URL ? describe : describe.skip;

async function loginAsSteam(steamId64: bigint): Promise<string> {
  const [row] = await h.db
    .select({ id: players.id })
    .from(players)
    .where(eq(players.steamId64, steamId64))
    .limit(1);
  if (!row) throw new Error(`No player for steamId64=${steamId64}`);
  invalidateAllPermissionCaches();
  const { token } = await createSession(h.db, h.redis, {
    playerId: row.id,
    ip: null,
    userAgent: 'economy-test',
    ttlMs: 21_600_000,
  });
  return `__Host-sid=${token}`;
}

async function seedPlayer(steamOffset: number, name: string): Promise<string> {
  const [row] = await h.db
    .insert(players)
    .values({
      steamId64: testSteamId(steamOffset),
      canonicalName: name,
      canonicalNameNormalized: name.toLowerCase(),
    })
    .returning({ id: players.id });
  if (!row) throw new Error(`failed to seed player ${name}`);
  return row.id;
}

async function seedAccrual(
  playerId: string,
  type: string,
  amount: number,
  referenceId: string,
  createdAt: Date,
): Promise<void> {
  await h.db.transaction(async (tx) => {
    await tx.insert(bonusTransactions).values({
      playerId,
      amount,
      type,
      referenceType: 'daily_presence',
      referenceId,
      createdAt,
    });
    await tx
      .update(players)
      .set({ bonusBalance: sql`${players.bonusBalance} + ${amount}` })
      .where(eq(players.id, playerId));
  });
}

async function ledgerSum(playerId: string): Promise<number> {
  const rows = await h.db
    .select({ total: sql<number>`COALESCE(SUM(${bonusTransactions.amount}), 0)::int` })
    .from(bonusTransactions)
    .where(eq(bonusTransactions.playerId, playerId));
  return rows[0]?.total ?? 0;
}

async function storedBalance(playerId: string): Promise<number> {
  const rows = await h.db
    .select({ balance: players.bonusBalance })
    .from(players)
    .where(eq(players.id, playerId))
    .limit(1);
  return rows[0]?.balance ?? 0;
}

beforeAll(async () => {
  h = await buildIntegrationApp({
    seedOwner: { steamId64: OWNER_STEAM, canonicalName: 'EconOwner' },
    bridge: makeFakeBridge(),
  });
  ownerCookie = await loginAsOwner(h);

  balancePlayerId = await seedPlayer(820010, 'BalancePlayer');
  reconPlayerId = await seedPlayer(820011, 'ReconPlayer');
  pagePlayerId = await seedPlayer(820012, 'PagePlayer');
  datePlayerId = await seedPlayer(820013, 'DatePlayer');

  const [eos] = await h.db
    .insert(players)
    .values({
      steamId64: null,
      eosId: EOS_ONLY_EOS,
      canonicalName: 'EconEos',
      canonicalNameNormalized: 'econeos',
    })
    .returning({ id: players.id });
  if (!eos) throw new Error('failed to seed eos player');
  eosPlayerId = eos.id;

  const [queuePriority] = await h.db
    .select({ id: roles.id })
    .from(roles)
    .where(eq(roles.name, 'QueuePriority'))
    .limit(1);
  await h.db
    .insert(players)
    .values({
      steamId64: NO_PANEL_STEAM,
      canonicalName: 'EconNoPanel',
      canonicalNameNormalized: 'econnopanel',
      roleId: queuePriority?.id ?? null,
    })
    .onConflictDoNothing();
  noPanelCookie = await loginAsSteam(NO_PANEL_STEAM);

  const [admin] = await h.db
    .select({ id: roles.id })
    .from(roles)
    .where(eq(roles.name, 'Admin'))
    .limit(1);
  await h.db
    .insert(players)
    .values({
      steamId64: ADMIN_STEAM,
      canonicalName: 'EconAdmin',
      canonicalNameNormalized: 'econadmin',
      roleId: admin?.id ?? null,
    })
    .onConflictDoNothing();
  adminCookie = await loginAsSteam(ADMIN_STEAM);

  const [econManagerRole] = await h.db
    .insert(roles)
    .values({
      id: randomUUID(),
      name: 'EconManagerTest',
      panelAccess: true,
      canManageEconomy: true,
    })
    .returning({ id: roles.id });
  await h.db.insert(players).values({
    steamId64: ECON_MANAGER_STEAM,
    canonicalName: 'EconManager',
    canonicalNameNormalized: 'econmanager',
    roleId: econManagerRole?.id ?? null,
  });
  econManagerCookie = await loginAsSteam(ECON_MANAGER_STEAM);

  const [roleEditorRole] = await h.db
    .insert(roles)
    .values({
      id: randomUUID(),
      name: 'RoleEditorTest',
      panelAccess: true,
      canEditRoles: true,
      canManageEconomy: false,
    })
    .returning({ id: roles.id });
  await h.db.insert(players).values({
    steamId64: ROLE_EDITOR_STEAM,
    canonicalName: 'RoleEditor',
    canonicalNameNormalized: 'roleeditor',
    roleId: roleEditorRole?.id ?? null,
  });
  roleEditorCookie = await loginAsSteam(ROLE_EDITOR_STEAM);
}, 120_000);

afterAll(async () => {
  invalidateAllPermissionCaches();
  await h.cleanup();
}, 60_000);

describeIfDb('GET /api/v1/players/:id/bonus-balance', () => {
  it('returns a zero balance for a freshly seeded player', async () => {
    const res = await h.app.inject({
      method: 'GET',
      url: `/api/v1/players/${balancePlayerId}/bonus-balance`,
      headers: { cookie: ownerCookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ player_id: balancePlayerId, balance: 0 });
  });

  it('rejects unauthenticated access with 401', async () => {
    const res = await h.app.inject({
      method: 'GET',
      url: `/api/v1/players/${balancePlayerId}/bonus-balance`,
    });
    expect(res.statusCode).toBe(401);
  });

  it('rejects a user without panel_access with 403', async () => {
    const res = await h.app.inject({
      method: 'GET',
      url: `/api/v1/players/${balancePlayerId}/bonus-balance`,
      headers: { cookie: noPanelCookie },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: 'forbidden' });
  });

  it('returns 404 for an unknown player', async () => {
    const res = await h.app.inject({
      method: 'GET',
      url: '/api/v1/players/00000000-0000-7000-8000-000000000000/bonus-balance',
      headers: { cookie: ownerCookie },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'player_not_found' });
  });
});

describeIfDb('POST /api/v1/players/:id/bonus-adjustments', () => {
  it('credits a positive adjustment and returns the ledger row', async () => {
    const res = await h.app.inject({
      method: 'POST',
      url: `/api/v1/players/${balancePlayerId}/bonus-adjustments`,
      headers: { cookie: ownerCookie, 'content-type': 'application/json' },
      payload: JSON.stringify({ amount: 150, comment: 'welcome bonus' }),
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as {
      player_id: string;
      balance: number;
      transaction: { amount: number; type: string; comment: string; actor_player_id: string };
    };
    expect(body.player_id).toBe(balancePlayerId);
    expect(body.balance).toBe(150);
    expect(body.transaction.amount).toBe(150);
    expect(body.transaction.type).toBe('adjust');
    expect(body.transaction.comment).toBe('welcome bonus');
    expect(body.transaction.actor_player_id).toBe(h.seed.ownerPlayerId);
    expect(await storedBalance(balancePlayerId)).toBe(150);
  });

  it('writes a player.bonus.adjust audit entry with before/after balance and the actor', async () => {
    const row = await assertAuditRow(h, {
      action: 'player.bonus.adjust',
      resource: 'player',
      targetId: balancePlayerId,
    });
    expect(row.actorKind).toBe('steam');
    expect(row.actorPlayerId).toBe(h.seed.ownerPlayerId);
    expect(row.beforeSnapshot).toMatchObject({ bonus_balance: 0 });
    expect(row.afterSnapshot).toMatchObject({ bonus_balance: 150 });
  });

  it('debits a negative adjustment that stays at or above zero', async () => {
    const res = await h.app.inject({
      method: 'POST',
      url: `/api/v1/players/${balancePlayerId}/bonus-adjustments`,
      headers: { cookie: ownerCookie, 'content-type': 'application/json' },
      payload: JSON.stringify({ amount: -50, comment: 'correction' }),
    });
    expect(res.statusCode).toBe(201);
    expect((res.json() as { balance: number }).balance).toBe(100);
    expect(await storedBalance(balancePlayerId)).toBe(100);
  });

  it('rejects spending below zero with 409 and leaves the balance untouched', async () => {
    const before = await storedBalance(balancePlayerId);
    const countBefore = (
      await h.db
        .select({ c: sql<number>`count(*)::int` })
        .from(bonusTransactions)
        .where(eq(bonusTransactions.playerId, balancePlayerId))
    )[0]?.c;
    const res = await h.app.inject({
      method: 'POST',
      url: `/api/v1/players/${balancePlayerId}/bonus-adjustments`,
      headers: { cookie: ownerCookie, 'content-type': 'application/json' },
      payload: JSON.stringify({ amount: -1_000, comment: 'overspend' }),
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: 'insufficient_balance', balance: before });
    expect(await storedBalance(balancePlayerId)).toBe(before);
    const countAfter = (
      await h.db
        .select({ c: sql<number>`count(*)::int` })
        .from(bonusTransactions)
        .where(eq(bonusTransactions.playerId, balancePlayerId))
    )[0]?.c;
    expect(countAfter).toBe(countBefore);
  });

  it('rejects a zero amount with 400', async () => {
    const res = await h.app.inject({
      method: 'POST',
      url: `/api/v1/players/${balancePlayerId}/bonus-adjustments`,
      headers: { cookie: ownerCookie, 'content-type': 'application/json' },
      payload: JSON.stringify({ amount: 0, comment: 'noop' }),
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects a blank comment with 400', async () => {
    const res = await h.app.inject({
      method: 'POST',
      url: `/api/v1/players/${balancePlayerId}/bonus-adjustments`,
      headers: { cookie: ownerCookie, 'content-type': 'application/json' },
      payload: JSON.stringify({ amount: 10, comment: '   ' }),
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects unauthenticated adjustments with 401', async () => {
    const res = await h.app.inject({
      method: 'POST',
      url: `/api/v1/players/${balancePlayerId}/bonus-adjustments`,
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ amount: 10, comment: 'x' }),
    });
    expect(res.statusCode).toBe(401);
  });

  it('rejects a panel user without can_manage_economy with 403 even though it can read the balance', async () => {
    const read = await h.app.inject({
      method: 'GET',
      url: `/api/v1/players/${balancePlayerId}/bonus-balance`,
      headers: { cookie: adminCookie },
    });
    expect(read.statusCode).toBe(200);

    const res = await h.app.inject({
      method: 'POST',
      url: `/api/v1/players/${balancePlayerId}/bonus-adjustments`,
      headers: { cookie: adminCookie, 'content-type': 'application/json' },
      payload: JSON.stringify({ amount: 10, comment: 'nope' }),
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: 'forbidden', required: 'can_manage_economy' });
  });

  it('rejects a role editor without can_manage_economy with 403 (gate is economy, not role:edit)', async () => {
    const res = await h.app.inject({
      method: 'POST',
      url: `/api/v1/players/${balancePlayerId}/bonus-adjustments`,
      headers: { cookie: roleEditorCookie, 'content-type': 'application/json' },
      payload: JSON.stringify({ amount: 10, comment: 'nope' }),
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: 'forbidden', required: 'can_manage_economy' });
  });

  it('allows a non-owner with can_manage_economy to adjust the balance', async () => {
    const targetId = await seedPlayer(820014, 'ManagerTarget');
    const res = await h.app.inject({
      method: 'POST',
      url: `/api/v1/players/${targetId}/bonus-adjustments`,
      headers: { cookie: econManagerCookie, 'content-type': 'application/json' },
      payload: JSON.stringify({ amount: 5, comment: 'econ manager grant' }),
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as { balance: number; transaction: { type: string; comment: string } };
    expect(body.balance).toBe(5);
    expect(body.transaction.type).toBe('adjust');
    expect(body.transaction.comment).toBe('econ manager grant');
  });

  it('returns 404 when adjusting an unknown player', async () => {
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/v1/players/00000000-0000-7000-8000-000000000000/bonus-adjustments',
      headers: { cookie: ownerCookie, 'content-type': 'application/json' },
      payload: JSON.stringify({ amount: 10, comment: 'ghost' }),
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'player_not_found' });
  });

  it('adjusts an EOS-only player (steam_id64 NULL) without error', async () => {
    const res = await h.app.inject({
      method: 'POST',
      url: `/api/v1/players/${eosPlayerId}/bonus-adjustments`,
      headers: { cookie: ownerCookie, 'content-type': 'application/json' },
      payload: JSON.stringify({ amount: 25, comment: 'eos credit' }),
    });
    expect(res.statusCode).toBe(201);
    expect((res.json() as { balance: number }).balance).toBe(25);
  });
});

describeIfDb('reconciliation: balance == SUM(ledger)', () => {
  it('keeps players.bonus_balance equal to the ledger sum across worker accruals and manual adjustments', async () => {
    const day = new Date();
    day.setUTCHours(0, 0, 0, 0);

    await seedAccrual(reconPlayerId, 'earn_online', 40, '2026-07-01', day);
    await seedAccrual(reconPlayerId, 'earn_boost', 10, '2026-07-01', day);

    for (const amount of [100, -30, 55, -20]) {
      const res = await h.app.inject({
        method: 'POST',
        url: `/api/v1/players/${reconPlayerId}/bonus-adjustments`,
        headers: { cookie: ownerCookie, 'content-type': 'application/json' },
        payload: JSON.stringify({ amount, comment: `adj ${amount}` }),
      });
      expect(res.statusCode).toBe(201);
    }

    const sum = await ledgerSum(reconPlayerId);
    const balance = await storedBalance(reconPlayerId);
    expect(sum).toBe(40 + 10 + 100 - 30 + 55 - 20);
    expect(balance).toBe(sum);

    const apiBalance = await h.app.inject({
      method: 'GET',
      url: `/api/v1/players/${reconPlayerId}/bonus-balance`,
      headers: { cookie: ownerCookie },
    });
    expect((apiBalance.json() as { balance: number }).balance).toBe(sum);
  });
});

describeIfDb('idempotent accruals', () => {
  it('rejects a duplicate accrual for the same (player, type, reference) with a unique violation', async () => {
    const accrualPlayerId = await seedPlayer(820020, 'AccrualPlayer');
    const createdAt = new Date();
    createdAt.setUTCHours(0, 0, 0, 0);

    await h.db.insert(bonusTransactions).values({
      playerId: accrualPlayerId,
      amount: 12,
      type: 'earn_online',
      referenceType: 'daily_presence',
      referenceId: '2026-07-02',
      createdAt,
    });

    let rejected = false;
    try {
      await h.db.insert(bonusTransactions).values({
        playerId: accrualPlayerId,
        amount: 12,
        type: 'earn_online',
        referenceType: 'daily_presence',
        referenceId: '2026-07-02',
        createdAt,
      });
    } catch (err) {
      const pgErr = err as { code?: string; cause?: { code?: string } };
      rejected = pgErr.code === '23505' || pgErr.cause?.code === '23505';
    }
    expect(rejected).toBe(true);

    const rows = await h.db
      .select({ c: sql<number>`count(*)::int` })
      .from(bonusTransactions)
      .where(
        and(
          eq(bonusTransactions.playerId, accrualPlayerId),
          eq(bonusTransactions.type, 'earn_online'),
        ),
      );
    expect(rows[0]?.c).toBe(1);
  });
});

describeIfDb('GET /api/v1/players/:id/bonus-transactions', () => {
  const pageCreatedAt = new Date();
  pageCreatedAt.setUTCHours(0, 0, 0, 0);

  beforeAll(async () => {
    for (let n = 0; n < 5; n++) {
      await h.db.insert(bonusTransactions).values({
        playerId: pagePlayerId,
        amount: 10 + n,
        type: n % 2 === 0 ? 'earn_online' : 'earn_boost',
        referenceType: 'daily_presence',
        referenceId: `2026-06-0${n + 1}`,
        createdAt: pageCreatedAt,
      });
    }
  }, 60_000);

  it('pages through the ledger by keyset with no lost or duplicated rows', async () => {
    const seen: number[] = [];
    let cursor: number | null = null;
    for (let guard = 0; guard < 10; guard++) {
      const url: string =
        `/api/v1/players/${pagePlayerId}/bonus-transactions?limit=2` +
        (cursor !== null ? `&before=${cursor}` : '');
      const res = await h.app.inject({ method: 'GET', url, headers: { cookie: ownerCookie } });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { items: Array<{ id: number }>; next_cursor: number | null };
      for (const item of body.items) seen.push(item.id);
      cursor = body.next_cursor;
      if (cursor === null) break;
    }
    expect(seen.length).toBe(5);
    expect(new Set(seen).size).toBe(5);
    const sortedDesc = [...seen].sort((a, b) => b - a);
    expect(seen).toEqual(sortedDesc);
  });

  it('filters the ledger by type', async () => {
    const res = await h.app.inject({
      method: 'GET',
      url: `/api/v1/players/${pagePlayerId}/bonus-transactions?type=earn_boost&limit=100`,
      headers: { cookie: ownerCookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { items: Array<{ type: string }> };
    expect(body.items.length).toBe(2);
    expect(body.items.every((tx) => tx.type === 'earn_boost')).toBe(true);
  });

  it('reports a count consistent with the returned rows', async () => {
    const total = await h.app.inject({
      method: 'GET',
      url: `/api/v1/players/${pagePlayerId}/bonus-transactions/count`,
      headers: { cookie: ownerCookie },
    });
    expect((total.json() as { count: number }).count).toBe(5);

    const filtered = await h.app.inject({
      method: 'GET',
      url: `/api/v1/players/${pagePlayerId}/bonus-transactions/count?type=earn_online`,
      headers: { cookie: ownerCookie },
    });
    expect((filtered.json() as { count: number }).count).toBe(3);
  });

  it('rejects a user without panel_access with 403', async () => {
    const res = await h.app.inject({
      method: 'GET',
      url: `/api/v1/players/${pagePlayerId}/bonus-transactions`,
      headers: { cookie: noPanelCookie },
    });
    expect(res.statusCode).toBe(403);
  });
});

describeIfDb('GET /api/v1/players/:id/bonus-transactions date filters', () => {
  const now = new Date();
  const y = now.getUTCFullYear();
  const mo = now.getUTCMonth();
  const prevMonth = new Date(Date.UTC(y, mo - 1, 10, 12, 0, 0));
  const currMonth = new Date(Date.UTC(y, mo, 10, 12, 0, 0));
  const nextMonth = new Date(Date.UTC(y, mo + 1, 10, 12, 0, 0));
  const currMonthStart = new Date(Date.UTC(y, mo, 1, 0, 0, 0));
  const nextMonthStart = new Date(Date.UTC(y, mo + 1, 1, 0, 0, 0));
  const afterNext = new Date(Date.UTC(y, mo + 2, 1, 0, 0, 0));

  beforeAll(async () => {
    const rows: Array<[Date, number]> = [
      [prevMonth, 10],
      [currMonth, 20],
      [nextMonth, 30],
    ];
    for (const [createdAt, amount] of rows) {
      await h.db.insert(bonusTransactions).values({
        playerId: datePlayerId,
        amount,
        type: 'earn_online',
        referenceType: 'daily_presence',
        referenceId: createdAt.toISOString().slice(0, 10),
        createdAt,
      });
    }
  }, 60_000);

  it('filters the ledger to a single month with a from/to window', async () => {
    const res = await h.app.inject({
      method: 'GET',
      url:
        `/api/v1/players/${datePlayerId}/bonus-transactions` +
        `?from=${currMonthStart.toISOString()}&to=${nextMonthStart.toISOString()}`,
      headers: { cookie: ownerCookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { items: Array<{ amount: number }> };
    expect(body.items.length).toBe(1);
    expect(body.items[0]?.amount).toBe(20);
  });

  it('applies from as an inclusive lower bound', async () => {
    const res = await h.app.inject({
      method: 'GET',
      url: `/api/v1/players/${datePlayerId}/bonus-transactions?from=${currMonth.toISOString()}`,
      headers: { cookie: ownerCookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { items: Array<{ amount: number }> };
    expect(body.items.map((tx) => tx.amount).sort((a, b) => a - b)).toEqual([20, 30]);
  });

  it('counts only rows inside the from/to window', async () => {
    const res = await h.app.inject({
      method: 'GET',
      url:
        `/api/v1/players/${datePlayerId}/bonus-transactions/count` +
        `?from=${currMonthStart.toISOString()}&to=${afterNext.toISOString()}`,
      headers: { cookie: ownerCookie },
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { count: number }).count).toBe(2);
  });
});
