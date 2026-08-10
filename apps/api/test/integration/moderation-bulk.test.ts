import {
  banlistPublicationSettings,
  events,
  moderationActions,
  players,
  roleSquadPermissions,
  roles,
  servers,
} from '@squad/db/schema';
import { and, eq, inArray } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

const OWNER_STEAM = testSteamId(986000);
const KICKER_STEAM = testSteamId(986001);
const NO_PANEL_STEAM = testSteamId(986002);
const TARGET_STEAM_BASE = 986100;

const URL = '/api/v1/moderation-actions/bulk';

let h: IntegrationHarness;
let serverId: string;
/** Five roster-online targets, in seed order. */
let targetIds: string[];

function okOutcome(overrides: Partial<WorkerRconCommandOutcome> = {}): WorkerRconCommandOutcome {
  return {
    attempted: true,
    ok: true,
    requestId: 'req-bulk-test',
    response: 'ok',
    via: 'worker-rcon',
    ...overrides,
  } as WorkerRconCommandOutcome;
}

function rejectedOutcome(): WorkerRconCommandOutcome {
  return {
    attempted: true,
    ok: false,
    requestId: 'req-bulk-test',
    reason: 'worker_rejected',
    detail: 'server said no',
    via: 'worker-rcon',
  };
}

async function seedTarget(index: number): Promise<{ id: string; eosId: string }> {
  const name = `BulkTarget${index}`;
  const eosId = `eos-bulk-${index}`;
  const [row] = await h.db
    .insert(players)
    .values({
      steamId64: testSteamId(TARGET_STEAM_BASE + index),
      canonicalName: name,
      canonicalNameNormalized: name.toLowerCase(),
      eosId,
    })
    .returning({ id: players.id });
  if (!row) throw new Error(`failed to seed target ${index}`);
  return { id: row.id, eosId };
}

async function seedServer(): Promise<string> {
  const id = uuidv7();
  await h.db.insert(servers).values({ id, displayName: 'Bulk Server', slug: `bulk-${id}` });
  return id;
}

/** Publishes a stored RCON roster so the route's warn/kick online check passes. */
async function seedRoster(entries: Array<{ eosId: string; steamId64: bigint }>): Promise<void> {
  await h.redis.set(
    `rcon:roster:${serverId}`,
    JSON.stringify({
      server_id: serverId,
      polled_at: new Date().toISOString(),
      players: entries.map((entry, index) => ({
        rcon_id: index,
        eos_id: entry.eosId,
        steam_id64: entry.steamId64.toString(),
        name: `BulkTarget${index}`,
        team_id: 1,
        squad_id: 1,
        is_leader: false,
        role: null,
        first_seen_at: new Date().toISOString(),
      })),
    }),
  );
}

/** Seeds a panel-access role carrying exactly `squadPermissionKeys` and a player in it. */
async function seedActorWithSquadPermissions(opts: {
  steamId64: bigint;
  panelAccess: boolean;
  squadPermissionKeys: string[];
}): Promise<string> {
  const roleId = uuidv7();
  await h.db.transaction(async (tx) => {
    await tx.insert(roles).values({
      id: roleId,
      name: `BulkTest-${roleId}`,
      color: 'blue',
      isSystemRole: false,
      panelAccess: opts.panelAccess,
    });
    for (const key of opts.squadPermissionKeys) {
      await tx.insert(roleSquadPermissions).values({ roleId, squadPermissionKey: key });
    }
  });
  const stub = `Bulk${String(opts.steamId64).slice(-6)}`;
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
  if (!row) throw new Error('failed to seed actor');
  return row.id;
}

async function loginAsPlayerId(playerIdValue: string): Promise<string> {
  invalidatePermissionCache(playerIdValue);
  const { token } = await createSession(h.db, h.redis, {
    playerId: playerIdValue,
    ip: null,
    userAgent: 'moderation-bulk-test',
    ttlMs: 21_600_000,
  });
  return `__Host-sid=${token}`;
}

interface BulkResultRow {
  player_id: string;
  status: 'applied' | 'failed';
  moderation_action_id?: string;
  error?: string;
  detail?: string;
}

interface BulkResponse {
  bulk_group: string;
  action_type: string;
  server_id: string;
  requested: number;
  applied: number;
  failed: number;
  results: BulkResultRow[];
}

async function ledgerRows(playerIds: string[]) {
  return h.db
    .select({
      id: moderationActions.id,
      playerId: moderationActions.playerId,
      actionType: moderationActions.actionType,
      authorPlayerId: moderationActions.authorPlayerId,
      reason: moderationActions.reason,
      context: moderationActions.context,
    })
    .from(moderationActions)
    .where(inArray(moderationActions.playerId, playerIds));
}

describeIfDb('POST /api/v1/moderation-actions/bulk', () => {
  beforeEach(async () => {
    vi.mocked(sendRconCommandViaWorker).mockReset();
    vi.mocked(sendRconCommandViaWorker).mockResolvedValue(okOutcome());
    h = await buildIntegrationApp({
      seedOwner: { steamId64: OWNER_STEAM },
      bridge: makeFakeBridge(),
    });
    serverId = await seedServer();
    const seeded = [];
    for (let index = 0; index < 5; index++) seeded.push(await seedTarget(index));
    targetIds = seeded.map((entry) => entry.id);
    await seedRoster(
      seeded.map((entry, index) => ({
        eosId: entry.eosId,
        steamId64: testSteamId(TARGET_STEAM_BASE + index),
      })),
    );
  });

  afterEach(async () => {
    invalidateAllPermissionCaches();
    if (h) await h.cleanup();
  });

  it('bans every target and writes one ledger row per target under a shared bulk_group', async () => {
    const cookie = await loginAsOwner(h);
    const res = await h.app.inject({
      method: 'POST',
      url: URL,
      headers: { cookie },
      payload: {
        server_id: serverId,
        action_type: 'ban',
        player_ids: targetIds,
        reason: 'Массовый бан читеров',
        ban_length: '7d',
        confirm_bulk: true,
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as BulkResponse;
    expect(body.requested).toBe(5);
    expect(body.applied).toBe(5);
    expect(body.failed).toBe(0);
    expect(body.results.every((row) => row.status === 'applied')).toBe(true);
    expect(body.bulk_group).toMatch(/^[0-9a-f-]{36}$/);

    const rows = await ledgerRows(targetIds);
    expect(rows).toHaveLength(5);
    const groups = new Set(
      rows.map((row) => (row.context as { bulk_group?: string }).bulk_group ?? ''),
    );
    expect(groups).toEqual(new Set([body.bulk_group]));
    expect(rows.every((row) => row.actionType === 'ban')).toBe(true);
    expect(rows.every((row) => row.authorPlayerId === h.seed.ownerPlayerId)).toBe(true);
    expect(rows.every((row) => row.reason === 'Массовый бан читеров')).toBe(true);
    const contexts = rows.map((row) => row.context as { ban_length?: string; bulk_size?: number });
    expect(contexts.every((ctx) => ctx.ban_length === '7d')).toBe(true);
    expect(contexts.every((ctx) => ctx.bulk_size === 5)).toBe(true);
  });

  it('sends exactly one AdminBan RCON command per target with the ban length and reason', async () => {
    const cookie = await loginAsOwner(h);
    await h.app.inject({
      method: 'POST',
      url: URL,
      headers: { cookie },
      payload: {
        server_id: serverId,
        action_type: 'ban',
        player_ids: targetIds,
        reason: 'Cheating',
        ban_length: '7d',
        confirm_bulk: true,
      },
    });

    const calls = vi.mocked(sendRconCommandViaWorker).mock.calls;
    expect(calls).toHaveLength(5);
    for (const [, opts] of calls) {
      expect(opts.serverId).toBe(serverId);
      expect(opts.command).toBe('AdminBan');
      expect(opts.args?.slice(1)).toEqual(['7d', 'Cheating']);
    }
    expect(new Set(calls.map(([, opts]) => opts.args?.[0]))).toEqual(
      new Set(['eos-bulk-0', 'eos-bulk-1', 'eos-bulk-2', 'eos-bulk-3', 'eos-bulk-4']),
    );
  });

  it('keeps going after a mid-loop RCON failure and leaves no applied target without a ledger row', async () => {
    const cookie = await loginAsOwner(h);
    let call = 0;
    vi.mocked(sendRconCommandViaWorker).mockImplementation(async () => {
      call += 1;
      return call === 3 ? rejectedOutcome() : okOutcome();
    });

    const res = await h.app.inject({
      method: 'POST',
      url: URL,
      headers: { cookie },
      payload: {
        server_id: serverId,
        action_type: 'ban',
        player_ids: targetIds,
        reason: 'Partial failure run',
        ban_length: '1d',
        confirm_bulk: true,
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as BulkResponse;
    expect(body.applied).toBe(4);
    expect(body.failed).toBe(1);
    expect(body.results).toHaveLength(5);
    expect(body.results[2]).toMatchObject({
      player_id: targetIds[2],
      status: 'failed',
      error: 'rcon_failed',
      detail: 'worker_rejected',
    });
    // Every target was attempted — the loop did not abort at the failure.
    expect(vi.mocked(sendRconCommandViaWorker).mock.calls).toHaveLength(5);

    const rows = await ledgerRows(targetIds);
    expect(rows).toHaveLength(4);
    const ledgered = new Set(rows.map((row) => row.playerId));
    // Targets 1-2 already enforced before the failure keep their ledger rows.
    expect(ledgered.has(targetIds[0] as string)).toBe(true);
    expect(ledgered.has(targetIds[1] as string)).toBe(true);
    expect(ledgered.has(targetIds[2] as string)).toBe(false);
    // Targets 4-5 after the failure were still processed.
    expect(ledgered.has(targetIds[3] as string)).toBe(true);
    expect(ledgered.has(targetIds[4] as string)).toBe(true);
  });

  it('marks an offline target as target_offline for kick without touching RCON or the ledger', async () => {
    const cookie = await loginAsOwner(h);
    const offline = await seedTarget(90);

    const res = await h.app.inject({
      method: 'POST',
      url: URL,
      headers: { cookie },
      payload: {
        server_id: serverId,
        action_type: 'kick',
        player_ids: [targetIds[0], offline.id],
        reason: 'Kick run',
        confirm_bulk: true,
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as BulkResponse;
    expect(body.applied).toBe(1);
    expect(body.failed).toBe(1);
    expect(body.results[1]).toMatchObject({ player_id: offline.id, error: 'target_offline' });
    expect(vi.mocked(sendRconCommandViaWorker).mock.calls).toHaveLength(1);
    expect(await ledgerRows([offline.id])).toHaveLength(0);
  });

  it('reports player_not_found per target instead of failing the whole request', async () => {
    const cookie = await loginAsOwner(h);
    const ghost = uuidv7();

    const res = await h.app.inject({
      method: 'POST',
      url: URL,
      headers: { cookie },
      payload: {
        server_id: serverId,
        action_type: 'ban',
        player_ids: [targetIds[0], ghost],
        reason: 'Ghost run',
        ban_length: '1d',
        confirm_bulk: true,
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as BulkResponse;
    expect(body.applied).toBe(1);
    expect(body.results[1]).toMatchObject({ player_id: ghost, error: 'player_not_found' });
  });

  it('rejects a body without confirm_bulk and a body with confirm_bulk false', async () => {
    const cookie = await loginAsOwner(h);
    const base = {
      server_id: serverId,
      action_type: 'kick',
      player_ids: [targetIds[0]],
      reason: 'No confirm',
    };

    const missing = await h.app.inject({
      method: 'POST',
      url: URL,
      headers: { cookie },
      payload: base,
    });
    expect(missing.statusCode).toBe(400);

    const falsy = await h.app.inject({
      method: 'POST',
      url: URL,
      headers: { cookie },
      payload: { ...base, confirm_bulk: false },
    });
    expect(falsy.statusCode).toBe(400);
    expect(vi.mocked(sendRconCommandViaWorker).mock.calls).toHaveLength(0);
  });

  it('rejects more than 50 player_ids', async () => {
    const cookie = await loginAsOwner(h);
    const res = await h.app.inject({
      method: 'POST',
      url: URL,
      headers: { cookie },
      payload: {
        server_id: serverId,
        action_type: 'kick',
        player_ids: Array.from({ length: 51 }, () => uuidv7()),
        reason: 'Too many',
        confirm_bulk: true,
      },
    });
    expect(res.statusCode).toBe(400);
  });

  it('deduplicates repeated player_ids into a single enforcement per player', async () => {
    const cookie = await loginAsOwner(h);
    const res = await h.app.inject({
      method: 'POST',
      url: URL,
      headers: { cookie },
      payload: {
        server_id: serverId,
        action_type: 'ban',
        player_ids: [targetIds[0], targetIds[1], targetIds[0], targetIds[1], targetIds[0]],
        reason: 'Duplicate run',
        ban_length: '1d',
        confirm_bulk: true,
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as BulkResponse;
    expect(body.requested).toBe(2);
    expect(body.applied).toBe(2);
    expect(body.results).toHaveLength(2);
    expect(vi.mocked(sendRconCommandViaWorker).mock.calls).toHaveLength(2);
    expect(await ledgerRows([targetIds[0] as string, targetIds[1] as string])).toHaveLength(2);
  });

  it('returns 404 for an unknown server', async () => {
    const cookie = await loginAsOwner(h);
    const res = await h.app.inject({
      method: 'POST',
      url: URL,
      headers: { cookie },
      payload: {
        server_id: uuidv7(),
        action_type: 'kick',
        player_ids: [targetIds[0]],
        reason: 'Nowhere',
        confirm_bulk: true,
      },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: 'server_not_found' });
  });

  it('writes one audit row per attempted target plus a summary row naming every target', async () => {
    const cookie = await loginAsOwner(h);
    const res = await h.app.inject({
      method: 'POST',
      url: URL,
      headers: { cookie },
      payload: {
        server_id: serverId,
        action_type: 'ban',
        player_ids: targetIds,
        reason: 'Audited run',
        ban_length: '2d',
        confirm_bulk: true,
      },
    });
    const body = res.json() as BulkResponse;

    for (const playerId of targetIds) {
      const row = await assertAuditRow(h, {
        action: 'moderation.bulk_action',
        resource: 'player',
        targetId: playerId,
      });
      expect(row.actorPlayerId).toBe(h.seed.ownerPlayerId);
      expect(row.afterSnapshot).toMatchObject({ action_type: 'ban', status: 'applied' });
      expect(row.context).toMatchObject({ bulk_group: body.bulk_group, bulk_size: 5 });
    }

    const summary = await assertAuditRow(h, {
      action: 'moderation.bulk_action',
      resource: 'server',
      targetId: serverId,
    });
    expect(summary.actorPlayerId).toBe(h.seed.ownerPlayerId);
    expect(summary.afterSnapshot).toMatchObject({
      action_type: 'ban',
      reason: 'Audited run',
      applied: 5,
      failed: 0,
    });
    expect((summary.afterSnapshot as { player_ids: string[] }).player_ids.sort()).toEqual(
      [...targetIds].sort(),
    );
    expect(summary.context).toMatchObject({ bulk_group: body.bulk_group });
  });

  it('publishes one moderation.ban event envelope per applied target', async () => {
    const cookie = await loginAsOwner(h);
    await h.app.inject({
      method: 'POST',
      url: URL,
      headers: { cookie },
      payload: {
        server_id: serverId,
        action_type: 'ban',
        player_ids: targetIds,
        reason: 'Event run',
        ban_length: '3d',
        confirm_bulk: true,
      },
    });

    const rows = await h.db
      .select({ kind: events.kind, payload: events.payload })
      .from(events)
      .where(and(eq(events.serverId, serverId), eq(events.kind, 'moderation.ban')));
    expect(rows).toHaveLength(5);

    const streamed = await h.redis.xrange(`events:server:${serverId}`, '-', '+');
    expect(streamed.length).toBeGreaterThanOrEqual(5);
  });

  it('exposes every bulk ban through the public federated banlist', async () => {
    const cookie = await loginAsOwner(h);
    await h.db
      .insert(banlistPublicationSettings)
      .values({ id: 1, enabled: true, publishScope: 'all_active' })
      .onConflictDoUpdate({
        target: banlistPublicationSettings.id,
        set: { enabled: true, publishScope: 'all_active' },
      });

    const before = await h.app.inject({
      method: 'GET',
      url: '/api/v1/public/banlist?format=json',
      headers: { cookie },
    });
    expect(before.statusCode).toBe(200);
    const beforeCount = (before.json() as { bans: unknown[] }).bans.length;

    await h.app.inject({
      method: 'POST',
      url: URL,
      headers: { cookie },
      payload: {
        server_id: serverId,
        action_type: 'ban',
        player_ids: targetIds,
        reason: 'Federated run',
        ban_length: '0',
        confirm_bulk: true,
      },
    });

    const after = await h.app.inject({
      method: 'GET',
      url: '/api/v1/public/banlist?format=json',
      headers: { cookie },
    });
    expect(after.statusCode).toBe(200);
    expect((after.json() as { bans: unknown[] }).bans).toHaveLength(beforeCount + 5);
  });

  it('stops enforcing once the bulk time budget is spent and flags the rest', async () => {
    const cookie = await loginAsOwner(h);
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() });
    try {
      vi.mocked(sendRconCommandViaWorker).mockImplementation(async () => {
        vi.setSystemTime(new Date(Date.now() + 20_000));
        return okOutcome();
      });

      const res = await h.app.inject({
        method: 'POST',
        url: URL,
        headers: { cookie },
        payload: {
          server_id: serverId,
          action_type: 'ban',
          player_ids: targetIds,
          reason: 'Slow run',
          ban_length: '1d',
          confirm_bulk: true,
        },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json() as BulkResponse;
      expect(body.applied).toBe(2);
      expect(body.failed).toBe(3);
      expect(body.results.slice(2).every((row) => row.error === 'bulk_deadline_exceeded')).toBe(
        true,
      );
      expect(vi.mocked(sendRconCommandViaWorker).mock.calls).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

describeIfDb('POST /api/v1/moderation-actions/bulk — RBAC', () => {
  beforeEach(async () => {
    vi.mocked(sendRconCommandViaWorker).mockReset();
    vi.mocked(sendRconCommandViaWorker).mockResolvedValue(okOutcome());
    h = await buildIntegrationApp({
      seedOwner: { steamId64: OWNER_STEAM },
      bridge: makeFakeBridge(),
    });
    serverId = await seedServer();
    const seeded = [];
    for (let index = 0; index < 2; index++) seeded.push(await seedTarget(index));
    targetIds = seeded.map((entry) => entry.id);
    await seedRoster(
      seeded.map((entry, index) => ({
        eosId: entry.eosId,
        steamId64: testSteamId(TARGET_STEAM_BASE + index),
      })),
    );
  });

  afterEach(async () => {
    invalidateAllPermissionCaches();
    if (h) await h.cleanup();
  });

  it('rejects an unauthenticated request with 401', async () => {
    const res = await h.app.inject({
      method: 'POST',
      url: URL,
      payload: {
        server_id: serverId,
        action_type: 'kick',
        player_ids: [targetIds[0]],
        reason: 'Anon',
        confirm_bulk: true,
      },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ error: 'unauthenticated' });
  });

  it('rejects a signed-in user without panel access with 403', async () => {
    const actorId = await seedActorWithSquadPermissions({
      steamId64: NO_PANEL_STEAM,
      panelAccess: false,
      squadPermissionKeys: ['kick', 'ban'],
    });
    const cookie = await loginAsPlayerId(actorId);
    const res = await h.app.inject({
      method: 'POST',
      url: URL,
      headers: { cookie },
      payload: {
        server_id: serverId,
        action_type: 'kick',
        player_ids: [targetIds[0]],
        reason: 'No panel',
        confirm_bulk: true,
      },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ error: 'forbidden' });
  });

  it('lets a mod:kick role bulk-kick but denies a permanent bulk ban with required mod:ban_perm', async () => {
    const actorId = await seedActorWithSquadPermissions({
      steamId64: KICKER_STEAM,
      panelAccess: true,
      squadPermissionKeys: ['kick'],
    });
    const cookie = await loginAsPlayerId(actorId);

    const kick = await h.app.inject({
      method: 'POST',
      url: URL,
      headers: { cookie },
      payload: {
        server_id: serverId,
        action_type: 'kick',
        player_ids: targetIds,
        reason: 'Kick allowed',
        confirm_bulk: true,
      },
    });
    expect(kick.statusCode).toBe(200);
    expect((kick.json() as BulkResponse).applied).toBe(2);

    const ban = await h.app.inject({
      method: 'POST',
      url: URL,
      headers: { cookie },
      payload: {
        server_id: serverId,
        action_type: 'ban',
        player_ids: targetIds,
        reason: 'Ban denied',
        ban_length: '0',
        confirm_bulk: true,
      },
    });
    expect(ban.statusCode).toBe(403);
    expect(ban.json()).toMatchObject({ error: 'forbidden', required: 'mod:ban_perm' });

    const temp = await h.app.inject({
      method: 'POST',
      url: URL,
      headers: { cookie },
      payload: {
        server_id: serverId,
        action_type: 'ban',
        player_ids: targetIds,
        reason: 'Temp ban denied',
        ban_length: '7d',
        confirm_bulk: true,
      },
    });
    expect(temp.statusCode).toBe(403);
    expect(temp.json()).toMatchObject({ error: 'forbidden', required: 'mod:ban_temp' });
  });
});
