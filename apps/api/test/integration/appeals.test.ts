import {
  banAppeals,
  events,
  moderationActions,
  players,
  roleSquadPermissions,
  roles,
  servers,
} from '@squad/db/schema';
import { PANEL_CONFIGS_ROOT } from '@squad/shared-config';
import { STREAM_NAME } from '@squad/shared-types';
import { and, eq } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { invalidateAllPermissionCaches, invalidatePermissionCache } from '../../src/lib/rbac.js';
import { createSession } from '../../src/lib/sessions.js';
import { testSteamId } from '../helpers/snapshot-restore.js';
import {
  assertAuditRow,
  buildIntegrationApp,
  type IntegrationHarness,
  loginAsOwner,
  makeFakeBridge,
} from './harness.js';

vi.mock('../../src/lib/rcon-worker-command.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/lib/rcon-worker-command.js')>()),
  sendRconCommandViaWorker: vi.fn(),
}));

import type { WorkerRconCommandOutcome } from '../../src/lib/rcon-worker-command.js';
import { sendRconCommandViaWorker } from '../../src/lib/rcon-worker-command.js';

const describeIfDb = process.env.DATABASE_URL ? describe : describe.skip;

const OWNER_STEAM = testSteamId(987000);
const UNBANNER_STEAM = testSteamId(987001);
const KICKER_ONLY_STEAM = testSteamId(987002);

/** Mirrors the daily Redis caps enforced by `public-appeals.ts`. */
const IP_DAILY_MAX = 10;
const STEAM_DAILY_MAX = 3;

let h: IntegrationHarness;
let serverId: string;
let unbannerId: string;
let unbannerCookie: string;
let kickerOnlyCookie: string;
let ownerCookie: string;

function okOutcome(): WorkerRconCommandOutcome {
  return {
    attempted: true,
    ok: true,
    requestId: 'appeal-test-rcon',
    response: 'ok',
    via: 'worker-rcon',
  } as WorkerRconCommandOutcome;
}

function bansCfgPath(id: string): string {
  return `${PANEL_CONFIGS_ROOT}/${id}/ServerConfig/Bans.cfg`;
}

async function seedPlayer(steamId64: bigint, name: string): Promise<string> {
  const [row] = await h.db
    .insert(players)
    .values({
      steamId64,
      canonicalName: name,
      canonicalNameNormalized: name.toLowerCase(),
      eosId: `eos-${name.toLowerCase()}`,
    })
    .returning({ id: players.id });
  if (!row) throw new Error(`failed to seed player ${name}`);
  return row.id;
}

/** Seeds a panel-access role carrying the given live-Squad permissions plus a player on it. */
async function seedActor(opts: { steamId64: bigint; squadPermissionKeys: string[] }): Promise<{
  playerId: string;
  cookie: string;
}> {
  const roleId = uuidv7();
  await h.db.transaction(async (tx) => {
    await tx.insert(roles).values({
      id: roleId,
      name: `AppealTest-${roleId}`,
      color: 'blue',
      isSystemRole: false,
      panelAccess: true,
    });
    for (const key of opts.squadPermissionKeys) {
      await tx.insert(roleSquadPermissions).values({ roleId, squadPermissionKey: key });
    }
  });
  const stub = `Ap${String(opts.steamId64).slice(-6)}`;
  const [row] = await h.db
    .insert(players)
    .values({
      steamId64: opts.steamId64,
      canonicalName: stub,
      canonicalNameNormalized: stub.toLowerCase(),
      eosId: `eos-${stub.toLowerCase()}`,
      roleId,
    })
    .returning({ id: players.id });
  if (!row) throw new Error('failed to seed appeal actor');
  invalidatePermissionCache(row.id);
  const { token } = await createSession(h.db, h.redis, {
    playerId: row.id,
    ip: null,
    userAgent: 'appeals-test',
    ttlMs: 21_600_000,
  });
  return { playerId: row.id, cookie: `__Host-sid=${token}` };
}

/** Seeds a banned player plus their active `ban` ledger row and Bans.cfg line. */
async function seedBannedPlayer(
  steamId64: bigint,
  name: string,
  opts: { banLength?: string } = {},
): Promise<{ playerId: string; actionId: string }> {
  const playerId = await seedPlayer(steamId64, name);
  const [action] = await h.db
    .insert(moderationActions)
    .values({
      playerId,
      serverId,
      actionType: 'ban',
      authorPlayerId: unbannerId,
      reason: 'aimbot',
      context: { ban_length: opts.banLength ?? '0' },
    })
    .returning({ id: moderationActions.id });
  if (!action) throw new Error('failed to seed ban action');

  const path = bansCfgPath(serverId);
  const current = h.bridge.files.get(path)?.toString('utf-8') ?? '';
  h.bridge.files.set(path, Buffer.from(`${current}Banned:${steamId64}:0 // ${name}\n`, 'utf-8'));

  return { playerId, actionId: action.id };
}

async function submitAppeal(payload: Record<string, unknown>) {
  return h.app.inject({
    method: 'POST',
    url: '/api/v1/public/appeals',
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify(payload),
  });
}

beforeAll(async () => {
  h = await buildIntegrationApp({
    seedOwner: { steamId64: OWNER_STEAM },
    bridge: makeFakeBridge(),
  });
  ownerCookie = await loginAsOwner(h);

  serverId = uuidv7();
  await h.db
    .insert(servers)
    .values({ id: serverId, displayName: 'Appeal Test Server', slug: `appeals-${serverId}` });

  const unbanner = await seedActor({ steamId64: UNBANNER_STEAM, squadPermissionKeys: ['ban'] });
  unbannerId = unbanner.playerId;
  unbannerCookie = unbanner.cookie;
  kickerOnlyCookie = (
    await seedActor({ steamId64: KICKER_ONLY_STEAM, squadPermissionKeys: ['kick'] })
  ).cookie;
}, 60_000);

afterAll(async () => {
  invalidateAllPermissionCaches();
  if (h) await h.cleanup();
}, 60_000);

beforeEach(async () => {
  vi.mocked(sendRconCommandViaWorker).mockReset().mockResolvedValue(okOutcome());
  // The IP-scoped daily cap is shared by every inject (all inject calls report
  // 127.0.0.1), so it has to be cleared between tests to stay deterministic.
  const keys = await h.redis.keys('appeal-rl:*');
  if (keys.length > 0) await h.redis.del(...keys);
});

describeIfDb('POST /api/v1/public/appeals (anonymous submission)', () => {
  it('creates a pending appeal without any session and returns a tracking token', async () => {
    const steamId64 = testSteamId(987100);
    await seedBannedPlayer(steamId64, 'AppealTarget100');

    const res = await submitAppeal({
      steam_id64: String(steamId64),
      body: 'Я был забанен по ошибке, прошу пересмотреть решение.',
      contact: 'discord: appellant#1',
    });

    expect(res.statusCode).toBe(201);
    const body = res.json() as {
      id: string;
      number: number;
      status: string;
      tracking_token: string;
    };
    expect(body.status).toBe('pending');
    expect(body.tracking_token).toMatch(/^[A-Za-z0-9_-]{16,}$/);
    expect(body.number).toBeGreaterThan(0);

    const [row] = await h.db
      .select()
      .from(banAppeals)
      .where(eq(banAppeals.steamId64, steamId64))
      .limit(1);
    expect(row?.status).toBe('pending');
    expect(row?.trackingToken).toBe(body.tracking_token);
    expect(row?.submitterIp).toBe('127.0.0.1');
  });

  it('links the submission to the player and their active ban', async () => {
    const steamId64 = testSteamId(987101);
    const { playerId, actionId } = await seedBannedPlayer(steamId64, 'AppealTarget101');

    const res = await submitAppeal({
      steam_id64: String(steamId64),
      body: 'Прошу снять бан, я исправился и больше не нарушаю.',
    });
    expect(res.statusCode).toBe(201);

    const [row] = await h.db
      .select()
      .from(banAppeals)
      .where(eq(banAppeals.steamId64, steamId64))
      .limit(1);
    expect(row?.playerId).toBe(playerId);
    expect(row?.moderationActionId).toBe(actionId);
  });

  it('answers identically for an unknown SteamID so it cannot enumerate bans', async () => {
    const bannedSteam = testSteamId(987102);
    const unknownSteam = testSteamId(987103);
    await seedBannedPlayer(bannedSteam, 'AppealTarget102');

    const banned = await submitAppeal({
      steam_id64: String(bannedSteam),
      body: 'Прошу пересмотреть мой бан, это была ошибка.',
    });
    const unknown = await submitAppeal({
      steam_id64: String(unknownSteam),
      body: 'Прошу пересмотреть мой бан, это была ошибка.',
    });

    expect(banned.statusCode).toBe(201);
    expect(unknown.statusCode).toBe(201);
    expect(Object.keys(unknown.json() as object).sort()).toEqual(
      Object.keys(banned.json() as object).sort(),
    );
    expect(unknown.json()).toMatchObject({ status: 'pending' });
  });

  it('answers identically for a player whose ban is already reverted', async () => {
    const steamId64 = testSteamId(987104);
    const { actionId } = await seedBannedPlayer(steamId64, 'AppealTarget104');
    await h.db
      .update(moderationActions)
      .set({ revertedAt: new Date() })
      .where(eq(moderationActions.id, actionId));

    const res = await submitAppeal({
      steam_id64: String(steamId64),
      body: 'Прошу пересмотреть мой бан, это была ошибка.',
    });

    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ status: 'pending' });
    const [row] = await h.db
      .select()
      .from(banAppeals)
      .where(eq(banAppeals.steamId64, steamId64))
      .limit(1);
    expect(row?.moderationActionId).toBeNull();
  });

  it('rejects a second open appeal for the same SteamID with 409', async () => {
    const steamId64 = testSteamId(987105);
    await seedBannedPlayer(steamId64, 'AppealTarget105');

    const first = await submitAppeal({
      steam_id64: String(steamId64),
      body: 'Первая апелляция по этому бану, прошу рассмотреть.',
    });
    expect(first.statusCode).toBe(201);

    const second = await submitAppeal({
      steam_id64: String(steamId64),
      body: 'Вторая апелляция по этому же бану, прошу рассмотреть.',
    });
    expect(second.statusCode).toBe(409);
    expect(second.json()).toEqual({ error: 'appeal_already_open' });
  });

  it('rejects a body shorter than the minimum and a body over 4000 chars', async () => {
    const steamId64 = testSteamId(987106);
    await seedBannedPlayer(steamId64, 'AppealTarget106');

    const tooShort = await submitAppeal({ steam_id64: String(steamId64), body: 'разбань' });
    expect(tooShort.statusCode).toBe(400);

    const tooLong = await submitAppeal({
      steam_id64: String(steamId64),
      body: 'я'.repeat(4001),
    });
    expect(tooLong.statusCode).toBe(400);

    const tooLongContact = await submitAppeal({
      steam_id64: String(steamId64),
      body: 'Нормальное тело апелляции достаточной длины.',
      contact: 'x'.repeat(201),
    });
    expect(tooLongContact.statusCode).toBe(400);
  });

  it('rejects a malformed steam_id64', async () => {
    const res = await submitAppeal({
      steam_id64: '123',
      body: 'Нормальное тело апелляции достаточной длины.',
    });
    expect(res.statusCode).toBe(400);
  });

  it('writes an appeal.create audit row with a system actor and the submitter IP', async () => {
    const steamId64 = testSteamId(987107);
    await seedBannedPlayer(steamId64, 'AppealTarget107');

    const res = await submitAppeal({
      steam_id64: String(steamId64),
      body: 'Прошу рассмотреть мою апелляцию по бану.',
    });
    expect(res.statusCode).toBe(201);
    const appealId = (res.json() as { id: string }).id;

    const row = await assertAuditRow(h, {
      action: 'appeal.create',
      resource: 'ban_appeal',
      targetId: appealId,
    });
    expect(row.actorKind).toBe('system');
    expect(row.actorSystemLabel).toBe('http-anonymous');
    expect(row.actorPlayerId).toBeNull();
    expect(row.actorIp).toBe('127.0.0.1');
  });

  it('never echoes the tracking token of somebody else back in the response', async () => {
    const steamA = testSteamId(987108);
    const steamB = testSteamId(987109);
    await seedBannedPlayer(steamA, 'AppealTarget108');
    await seedBannedPlayer(steamB, 'AppealTarget109');

    const a = await submitAppeal({
      steam_id64: String(steamA),
      body: 'Апелляция первого игрока, прошу рассмотреть.',
    });
    const b = await submitAppeal({
      steam_id64: String(steamB),
      body: 'Апелляция второго игрока, прошу рассмотреть.',
    });

    expect((a.json() as { tracking_token: string }).tracking_token).not.toBe(
      (b.json() as { tracking_token: string }).tracking_token,
    );
  });
});

describeIfDb('POST /api/v1/public/appeals anti-abuse limits', () => {
  it('returns 429 once the per-SteamID daily cap is exceeded', async () => {
    const steamId64 = testSteamId(987120);
    await seedBannedPlayer(steamId64, 'AppealTarget120');

    for (let i = 0; i < STEAM_DAILY_MAX; i++) {
      const res = await submitAppeal({
        steam_id64: String(steamId64),
        body: `Апелляция номер ${i} по этому бану, прошу рассмотреть.`,
      });
      expect([201, 409]).toContain(res.statusCode);
    }

    const blocked = await submitAppeal({
      steam_id64: String(steamId64),
      body: 'Ещё одна апелляция сверх суточного лимита по SteamID.',
    });
    expect(blocked.statusCode).toBe(429);
    expect(blocked.json()).toMatchObject({ error: 'rate_limited' });
  });

  it('returns 429 once the per-IP daily cap is exceeded', async () => {
    await h.redis.set(`appeal-rl:ip:127.0.0.1`, String(IP_DAILY_MAX), 'EX', 86_400);
    const steamId64 = testSteamId(987121);
    await seedBannedPlayer(steamId64, 'AppealTarget121');

    const blocked = await submitAppeal({
      steam_id64: String(steamId64),
      body: 'Апелляция сверх суточного лимита по IP-адресу.',
    });
    expect(blocked.statusCode).toBe(429);
    expect(blocked.json()).toMatchObject({ error: 'rate_limited' });

    const rows = await h.db.select().from(banAppeals).where(eq(banAppeals.steamId64, steamId64));
    expect(rows).toHaveLength(0);
  });

  it('gives every anti-abuse counter a TTL so limits reset', async () => {
    const steamId64 = testSteamId(987122);
    await seedBannedPlayer(steamId64, 'AppealTarget122');

    const res = await submitAppeal({
      steam_id64: String(steamId64),
      body: 'Апелляция, проверяющая TTL счётчиков анти-абьюза.',
    });
    expect(res.statusCode).toBe(201);

    expect(await h.redis.ttl('appeal-rl:ip:127.0.0.1')).toBeGreaterThan(0);
    expect(await h.redis.ttl(`appeal-rl:steam:${steamId64}`)).toBeGreaterThan(0);
  });
});

describeIfDb('GET /api/v1/public/appeals/:token (applicant status page)', () => {
  it('returns only the whitelisted applicant-facing fields', async () => {
    const steamId64 = testSteamId(987140);
    await seedBannedPlayer(steamId64, 'AppealTarget140');
    const created = await submitAppeal({
      steam_id64: String(steamId64),
      body: 'Апелляция для проверки проекции публичного ответа.',
      contact: 'discord: secret#9999',
    });
    const token = (created.json() as { tracking_token: string }).tracking_token;
    const appealId = (created.json() as { id: string }).id;
    await h.db
      .update(banAppeals)
      .set({ internalNote: 'внутренняя заметка' })
      .where(eq(banAppeals.id, appealId));

    const res = await h.app.inject({ method: 'GET', url: `/api/v1/public/appeals/${token}` });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<string, unknown>;

    expect(Object.keys(body).sort()).toEqual(
      ['created_at', 'decided_at', 'decision_note', 'number', 'status'].sort(),
    );
    const raw = res.body;
    expect(raw).not.toContain('внутренняя заметка');
    expect(raw).not.toContain('secret#9999');
    expect(raw).not.toContain(String(steamId64));
  });

  it('returns 404 for an unknown token', async () => {
    const res = await h.app.inject({
      method: 'GET',
      url: '/api/v1/public/appeals/definitely-not-a-real-tracking-token',
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'appeal_not_found' });
  });
});

describeIfDb('GET /api/v1/appeals (panel queue, mod:unban)', () => {
  it('rejects an unauthenticated request with 401', async () => {
    const res = await h.app.inject({ method: 'GET', url: '/api/v1/appeals' });
    expect(res.statusCode).toBe(401);
  });

  it('rejects a panel user without the squad ban permission with 403', async () => {
    const res = await h.app.inject({
      method: 'GET',
      url: '/api/v1/appeals',
      headers: { cookie: kickerOnlyCookie },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ error: 'forbidden' });
  });

  it('returns a paginated queue to a user holding mod:unban', async () => {
    const steamId64 = testSteamId(987160);
    await seedBannedPlayer(steamId64, 'AppealTarget160');
    await submitAppeal({
      steam_id64: String(steamId64),
      body: 'Апелляция, которая должна попасть в очередь панели.',
    });

    const res = await h.app.inject({
      method: 'GET',
      url: '/api/v1/appeals?status=pending&page=1&page_size=100',
      headers: { cookie: unbannerCookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      items: Array<{ steam_id64: string; status: string; body: string }>;
      total: number;
      page: number;
      page_size: number;
    };
    expect(body.page).toBe(1);
    expect(body.page_size).toBe(100);
    expect(body.total).toBeGreaterThan(0);
    const mine = body.items.find((item) => item.steam_id64 === String(steamId64));
    expect(mine?.status).toBe('pending');
    expect(mine?.body).toContain('очередь панели');
  });

  it('returns a single appeal by id and 404 for an unknown id', async () => {
    const steamId64 = testSteamId(987161);
    await seedBannedPlayer(steamId64, 'AppealTarget161');
    const created = await submitAppeal({
      steam_id64: String(steamId64),
      body: 'Апелляция для карточки в панели, прошу рассмотреть.',
    });
    const appealId = (created.json() as { id: string }).id;

    const ok = await h.app.inject({
      method: 'GET',
      url: `/api/v1/appeals/${appealId}`,
      headers: { cookie: unbannerCookie },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ id: appealId, steam_id64: String(steamId64) });

    const missing = await h.app.inject({
      method: 'GET',
      url: `/api/v1/appeals/${uuidv7()}`,
      headers: { cookie: unbannerCookie },
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toEqual({ error: 'appeal_not_found' });
  });
});

describeIfDb('PATCH /api/v1/appeals/:id (status transitions)', () => {
  async function openAppeal(steamId64: bigint, name: string): Promise<string> {
    await seedBannedPlayer(steamId64, name);
    const created = await submitAppeal({
      steam_id64: String(steamId64),
      body: `Апелляция игрока ${name}, прошу пересмотреть решение.`,
    });
    expect(created.statusCode).toBe(201);
    return (created.json() as { id: string }).id;
  }

  function patch(id: string, payload: Record<string, unknown>, cookie = unbannerCookie) {
    return h.app.inject({
      method: 'PATCH',
      url: `/api/v1/appeals/${id}`,
      headers: { cookie, 'content-type': 'application/json' },
      payload: JSON.stringify(payload),
    });
  }

  it('rejects a panel user without the squad ban permission with 403', async () => {
    const appealId = await openAppeal(testSteamId(987180), 'AppealTarget180');
    const res = await patch(appealId, { status: 'in_review' }, kickerOnlyCookie);
    expect(res.statusCode).toBe(403);
  });

  it('moves pending to in_review and records the handler', async () => {
    const appealId = await openAppeal(testSteamId(987181), 'AppealTarget181');

    const res = await patch(appealId, { status: 'in_review', internal_note: 'смотрю логи' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ appeal: { status: 'in_review' }, revert: null });

    const [row] = await h.db.select().from(banAppeals).where(eq(banAppeals.id, appealId)).limit(1);
    expect(row?.handlerPlayerId).toBe(unbannerId);
    expect(row?.internalNote).toBe('смотрю логи');
    expect(row?.decidedAt).toBeNull();
  });

  it('writes an appeal.status_change audit row with before/after snapshots', async () => {
    const appealId = await openAppeal(testSteamId(987182), 'AppealTarget182');

    const res = await patch(appealId, { status: 'in_review' });
    expect(res.statusCode).toBe(200);

    const row = await assertAuditRow(h, {
      action: 'appeal.status_change',
      resource: 'ban_appeal',
      targetId: appealId,
    });
    expect((row.beforeSnapshot as { status: string }).status).toBe('pending');
    expect((row.afterSnapshot as { status: string }).status).toBe('in_review');
  });

  it('rejects an appeal without touching moderation_actions', async () => {
    const steamId64 = testSteamId(987183);
    const appealId = await openAppeal(steamId64, 'AppealTarget183');

    const res = await patch(appealId, { status: 'rejected', decision_note: 'бан подтверждён' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ appeal: { status: 'rejected' }, revert: null });

    const [player] = await h.db
      .select({ id: players.id })
      .from(players)
      .where(eq(players.steamId64, steamId64))
      .limit(1);
    const bans = await h.db
      .select({ revertedAt: moderationActions.revertedAt })
      .from(moderationActions)
      .where(
        and(
          eq(moderationActions.playerId, player?.id ?? ''),
          eq(moderationActions.actionType, 'ban'),
        ),
      );
    expect(bans.length).toBeGreaterThan(0);
    for (const ban of bans) expect(ban.revertedAt).toBeNull();

    const [row] = await h.db.select().from(banAppeals).where(eq(banAppeals.id, appealId)).limit(1);
    expect(row?.decidedAt).not.toBeNull();
    expect(row?.decisionNote).toBe('бан подтверждён');

    await assertAuditRow(h, {
      action: 'appeal.status_change',
      resource: 'ban_appeal',
      targetId: appealId,
    });
  });

  it('returns 409 when transitioning out of a terminal status', async () => {
    const appealId = await openAppeal(testSteamId(987184), 'AppealTarget184');
    expect((await patch(appealId, { status: 'rejected' })).statusCode).toBe(200);

    const again = await patch(appealId, { status: 'approved' });
    expect(again.statusCode).toBe(409);
    expect(again.json()).toEqual({ error: 'appeal_already_decided' });
  });

  it('returns 400 for a no-op in_review -> in_review transition', async () => {
    const appealId = await openAppeal(testSteamId(987185), 'AppealTarget185');
    expect((await patch(appealId, { status: 'in_review' })).statusCode).toBe(200);

    const again = await patch(appealId, { status: 'in_review' });
    expect(again.statusCode).toBe(400);
    expect(again.json()).toEqual({ error: 'invalid_transition' });
  });

  it('returns 404 for an unknown appeal id', async () => {
    const res = await patch(uuidv7(), { status: 'in_review' });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'appeal_not_found' });
  });

  it('approving reverts every active ban row and removes only that Bans.cfg line', async () => {
    const steamId64 = testSteamId(987186);
    const otherSteam = testSteamId(987187);
    const appealId = await openAppeal(steamId64, 'AppealTarget186');
    await seedBannedPlayer(otherSteam, 'AppealBystander187');

    const [player] = await h.db
      .select({ id: players.id })
      .from(players)
      .where(eq(players.steamId64, steamId64))
      .limit(1);
    if (!player) throw new Error('appellant player missing');
    // Squad appends a fresh Banned: line per AdminBan, so a player can hold
    // several active ban rows; approving must clear all of them.
    await h.db.insert(moderationActions).values({
      playerId: player.id,
      serverId,
      actionType: 'ban',
      authorPlayerId: unbannerId,
      reason: 'повторный бан',
      context: { ban_length: '0' },
    });

    const res = await patch(appealId, { status: 'approved', decision_note: 'бан снят' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      appeal: { status: string; decided_at: string | null };
      revert: { reverted_action_ids: string[]; unban_action_ids: string[]; removed_lines: number };
    };
    expect(body.appeal.status).toBe('approved');
    expect(body.appeal.decided_at).not.toBeNull();
    expect(body.revert.reverted_action_ids).toHaveLength(2);
    expect(body.revert.unban_action_ids).toHaveLength(1);
    expect(body.revert.removed_lines).toBe(1);

    const bans = await h.db
      .select({
        revertedAt: moderationActions.revertedAt,
        revertedBy: moderationActions.revertedBy,
      })
      .from(moderationActions)
      .where(
        and(eq(moderationActions.playerId, player.id), eq(moderationActions.actionType, 'ban')),
      );
    expect(bans).toHaveLength(2);
    for (const ban of bans) {
      expect(ban.revertedAt).not.toBeNull();
      expect(ban.revertedBy).toBe(unbannerId);
    }

    const cfg = h.bridge.files.get(bansCfgPath(serverId))?.toString('utf-8') ?? '';
    expect(cfg).not.toContain(`Banned:${steamId64}:`);
    expect(cfg).toContain(`Banned:${otherSteam}:`);
  });

  it('approving inserts an unban ledger row referencing the appeal', async () => {
    const steamId64 = testSteamId(987188);
    const appealId = await openAppeal(steamId64, 'AppealTarget188');

    const res = await patch(appealId, { status: 'approved' });
    expect(res.statusCode).toBe(200);
    const unbanId = (res.json() as { revert: { unban_action_ids: string[] } }).revert
      .unban_action_ids[0];

    const [unban] = await h.db
      .select()
      .from(moderationActions)
      .where(eq(moderationActions.id, unbanId ?? ''))
      .limit(1);
    expect(unban?.actionType).toBe('unban');
    expect(unban?.authorPlayerId).toBe(unbannerId);
    expect((unban?.context as { appeal_id?: string }).appeal_id).toBe(appealId);
  });

  it('approving publishes a moderation.unban EVT-1 envelope on the server stream', async () => {
    const steamId64 = testSteamId(987189);
    const appealId = await openAppeal(steamId64, 'AppealTarget189');
    const before = await h.redis.xlen(STREAM_NAME.eventsServer(serverId));

    expect((await patch(appealId, { status: 'approved' })).statusCode).toBe(200);

    const rows = await h.db.select().from(events).where(eq(events.kind, 'moderation.unban'));
    const mine = rows.find(
      (row) => (row.payload as { steam_id64?: string }).steam_id64 === String(steamId64),
    );
    expect(mine).toBeTruthy();
    expect((mine?.payload as { action_type: string }).action_type).toBe('unban');
    expect(mine?.serverId).toBe(serverId);

    expect(await h.redis.xlen(STREAM_NAME.eventsServer(serverId))).toBeGreaterThan(before);
  });

  it('approving writes both an appeal.status_change and an appeal.unban audit row', async () => {
    const appealId = await openAppeal(testSteamId(987190), 'AppealTarget190');

    expect((await patch(appealId, { status: 'approved' })).statusCode).toBe(200);

    await assertAuditRow(h, {
      action: 'appeal.status_change',
      resource: 'ban_appeal',
      targetId: appealId,
    });
    const unbanAudit = await assertAuditRow(h, {
      action: 'appeal.unban',
      resource: 'ban_appeal',
      targetId: appealId,
    });
    expect(
      (unbanAudit.context as { reverted_action_ids?: string[] }).reverted_action_ids,
    ).toBeTruthy();
  });

  it('publishes the decision to the applicant status page', async () => {
    const steamId64 = testSteamId(987191);
    await seedBannedPlayer(steamId64, 'AppealTarget191');
    const created = await submitAppeal({
      steam_id64: String(steamId64),
      body: 'Апелляция, решение по которой заявитель читает по токену.',
    });
    const { id, tracking_token: token } = created.json() as { id: string; tracking_token: string };

    expect((await patch(id, { status: 'approved', decision_note: 'бан снят' })).statusCode).toBe(
      200,
    );

    const status = await h.app.inject({ method: 'GET', url: `/api/v1/public/appeals/${token}` });
    expect(status.statusCode).toBe(200);
    expect(status.json()).toMatchObject({ status: 'approved', decision_note: 'бан снят' });
    expect((status.json() as { decided_at: string | null }).decided_at).not.toBeNull();
  });
});

describeIfDb('approve removes the player from the published banlist', () => {
  it('drops the appellant from GET /api/v1/public/banlist?format=json', async () => {
    const steamId64 = testSteamId(987200);
    await seedBannedPlayer(steamId64, 'AppealTarget200');
    const created = await submitAppeal({
      steam_id64: String(steamId64),
      body: 'Апелляция, после одобрения которой бан уходит из федерации.',
    });
    const appealId = (created.json() as { id: string }).id;

    const enable = await h.app.inject({
      method: 'PUT',
      url: '/api/v1/settings/banlist-publication',
      headers: { cookie: ownerCookie, 'content-type': 'application/json' },
      payload: JSON.stringify({ enabled: true, publish_scope: 'all_active' }),
    });
    expect(enable.statusCode).toBe(200);

    const beforeRes = await h.app.inject({
      method: 'GET',
      url: '/api/v1/public/banlist?format=json',
      headers: { cookie: ownerCookie },
    });
    expect(beforeRes.statusCode).toBe(200);
    expect(beforeRes.body).toContain(String(steamId64));

    const patched = await h.app.inject({
      method: 'PATCH',
      url: `/api/v1/appeals/${appealId}`,
      headers: { cookie: unbannerCookie, 'content-type': 'application/json' },
      payload: JSON.stringify({ status: 'approved' }),
    });
    expect(patched.statusCode).toBe(200);

    const afterRes = await h.app.inject({
      method: 'GET',
      url: '/api/v1/public/banlist?format=json',
      headers: { cookie: ownerCookie },
    });
    expect(afterRes.statusCode).toBe(200);
    expect(afterRes.body).not.toContain(String(steamId64));
  });
});
