import { createHash, createHmac } from 'node:crypto';
import {
  adminsCfgSyncOutbox,
  auditLog,
  players,
  roles,
  servers,
  vipLifecycleEvents,
  vipSubscriptions,
  vipTiers,
} from '@squad/db/schema';
import { and, desc, eq, sql } from 'drizzle-orm';
import postgres from 'postgres';
import { v7 as uuidv7 } from 'uuid';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildIntegrationApp, type IntegrationHarness, makeFakeBridge } from './harness.js';

const SECRET = 'vip-lifecycle-test-secret-with-enough-entropy';
let h: IntegrationHarness;
let playerId: string;
let roleId: string;
let serverId: string;
let tierId: string;

const describeIfDb = process.env.DATABASE_URL ? describe : describe.skip;

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(',')}}`;
}

function sign(payload: unknown, timestamp: string): string {
  return `sha256=${createHmac('sha256', SECRET)
    .update(`${timestamp}.${canonicalJson(payload)}`)
    .digest('hex')}`;
}

async function postSigned(path: string, payload: Record<string, unknown>, signature?: string) {
  const timestamp = new Date().toISOString();
  return h.app.inject({
    method: 'POST',
    url: path,
    headers: {
      'content-type': 'application/json',
      'x-vip-timestamp': timestamp,
      'x-vip-signature': signature ?? sign(payload, timestamp),
    },
    payload: JSON.stringify(payload),
  });
}

async function postLifecycle(payload: Record<string, unknown>, signature?: string) {
  return postSigned('/api/v1/integrations/vip/lifecycle', payload, signature);
}

async function postPreflight(payload: Record<string, unknown>, signature?: string) {
  return postSigned('/api/v1/integrations/vip/preflight', payload, signature);
}

async function postStatus(eventId: string, signature?: string) {
  return postSigned('/api/v1/integrations/vip/status', { event_id: eventId }, signature);
}

function expectSafeStatusBody(body: Record<string, unknown>) {
  const serialized = JSON.stringify(body);
  for (const forbidden of [
    'steam_id64',
    'discord_id',
    'eos_id',
    'payload',
    'file_path',
    'rcon_response',
    '76561198000990001',
    'vip-lifecycle-eos-',
    '/srv/squad/',
    'raw RCON failure',
  ]) {
    expect(serialized).not.toContain(forbidden);
  }
}

async function waitForBlockedStatusOutboxRead(): Promise<void> {
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
          AND query ILIKE '%admins_cfg_sync_outbox%'
      `;
      if ((rows[0]?.waiting ?? 0) > 0) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error('status did not wait for the outbox relation lock');
  } finally {
    await observer.end();
  }
}

async function mutationCounts(eventId: string) {
  const [events, audits, outbox] = await Promise.all([
    h.db
      .select({ id: vipLifecycleEvents.eventId })
      .from(vipLifecycleEvents)
      .where(eq(vipLifecycleEvents.eventId, eventId)),
    h.db
      .select({ id: auditLog.id })
      .from(auditLog)
      .where(eq(auditLog.actionType, 'vip.lifecycle.apply')),
    h.db.select({ id: adminsCfgSyncOutbox.id }).from(adminsCfgSyncOutbox),
  ]);
  return { events: events.length, audits: audits.length, outbox: outbox.length };
}

async function syncTasks() {
  return h.db
    .select({
      correlationId: adminsCfgSyncOutbox.correlationId,
      payload: adminsCfgSyncOutbox.payload,
    })
    .from(adminsCfgSyncOutbox)
    .where(eq(adminsCfgSyncOutbox.serverId, serverId));
}

async function latestVipAudit() {
  const rows = await h.db
    .select()
    .from(auditLog)
    .where(eq(auditLog.actionType, 'vip.lifecycle.apply'))
    .orderBy(desc(auditLog.createdAt))
    .limit(1);
  return rows[0] ?? null;
}

describeIfDb('VIP lifecycle integration endpoint', () => {
  beforeEach(async () => {
    h = await buildIntegrationApp({ bridge: makeFakeBridge() });
    (h.app.config as Record<string, unknown>).VIP_LIFECYCLE_WEBHOOK_SECRET = SECRET;
    (h.app.config as Record<string, unknown>).VIP_LIFECYCLE_REQUIRE_REVISION = false;

    roleId = uuidv7();
    serverId = uuidv7();
    const playerRows = await h.db
      .insert(players)
      .values({
        steamId64: 76561198000990001n,
        canonicalName: 'VipLifecyclePlayer',
        canonicalNameNormalized: 'viplifecycleplayer',
        eosId: `vip-lifecycle-eos-${Date.now()}`,
      })
      .returning({ id: players.id });
    playerId = playerRows[0]?.id ?? '';
    await h.db.insert(roles).values({
      id: roleId,
      name: `VIP Tier 2 ${Date.now()}`,
      color: '#DAA520',
      isSystemRole: false,
      panelAccess: false,
    });
    tierId = uuidv7();
    await h.db.insert(vipTiers).values({
      id: tierId,
      name: `VIP Bronze ${Date.now()}`,
      roleId,
      isActive: true,
    });
    await h.db.insert(servers).values({
      id: serverId,
      displayName: 'VIP lifecycle server',
      slug: `vip-lifecycle-${Date.now()}`,
      status: 'ready',
    });
  }, 60_000);

  afterEach(async () => {
    vi.useRealTimers();
    await h.cleanup();
  }, 60_000);

  it('migrates lifecycle revision metadata and the partial player revision uniqueness guard', async () => {
    const columns = (await h.db.execute(sql`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = current_schema()
        AND table_name = 'vip_lifecycle_events'
        AND column_name IN ('revision', 'request_hash', 'superseded_by_event_id')
      ORDER BY column_name
    `)) as unknown as Array<{ column_name: string }>;
    const indexes = (await h.db.execute(sql`
      SELECT indexdef
      FROM pg_indexes
      WHERE schemaname = current_schema()
        AND tablename = 'vip_lifecycle_events'
        AND indexname = 'vip_lifecycle_events_player_revision_key'
    `)) as unknown as Array<{ indexdef: string }>;

    expect(columns.map((row) => row.column_name)).toEqual([
      'request_hash',
      'revision',
      'superseded_by_event_id',
    ]);
    expect(indexes[0]?.indexdef).toContain('UNIQUE');
    expect(indexes[0]?.indexdef).toContain('WHERE (revision IS NOT NULL)');
  });

  it('returns 404 for an unknown signed lifecycle event', async () => {
    const response = await postStatus('vip-status-unknown');

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({
      error: 'event_not_found',
      error_code: 'event_not_found',
    });
  });

  it('requires the same valid HMAC boundary for lifecycle status', async () => {
    const response = await postStatus('vip-status-auth', 'sha256=bad');

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: 'invalid_signature' });
  });

  it('reports accepted, applying and applied only after every server is durably applied', async () => {
    const secondServerId = uuidv7();
    await h.db.insert(servers).values({
      id: secondServerId,
      displayName: 'VIP lifecycle second server',
      slug: `vip-lifecycle-second-${Date.now()}`,
      status: 'ready',
    });
    const eventId = 'vip-status-progress';
    expect(
      (
        await postLifecycle({
          event_id: eventId,
          event_type: 'vip.purchased',
          player_id: playerId,
          steam_id64: '76561198000990001',
          role_id: roleId,
          tier: 'tier_1',
          purchase_id: 'purchase-status-progress',
          expires_at: '2030-01-02T03:04:05.000Z',
          revision: 1,
          discord_id: '123456789012345678',
        })
      ).statusCode,
    ).toBe(202);

    const accepted = await postStatus(eventId);
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json()).toEqual({
      ok: true,
      event_id: eventId,
      state: 'accepted',
      action: 'assigned',
      servers_total: 2,
      servers_applied: 0,
      servers_pending: 2,
      error_codes: [],
    });
    expectSafeStatusBody(accepted.json());

    await h.db
      .update(adminsCfgSyncOutbox)
      .set({ relayedAt: new Date() })
      .where(eq(adminsCfgSyncOutbox.correlationId, eventId));
    const applying = await postStatus(eventId);
    expect(applying.json()).toEqual({
      ok: true,
      event_id: eventId,
      state: 'applying',
      action: 'assigned',
      servers_total: 2,
      servers_applied: 0,
      servers_pending: 2,
      error_codes: [],
    });
    expectSafeStatusBody(applying.json());

    await h.db
      .update(adminsCfgSyncOutbox)
      .set({ appliedAt: new Date(), reloadOutcome: 'confirmed' })
      .where(
        and(
          eq(adminsCfgSyncOutbox.correlationId, eventId),
          eq(adminsCfgSyncOutbox.serverId, serverId),
        ),
      );
    const partiallyApplied = await postStatus(eventId);
    expect(partiallyApplied.json()).toEqual({
      ok: true,
      event_id: eventId,
      state: 'applying',
      action: 'assigned',
      servers_total: 2,
      servers_applied: 1,
      servers_pending: 1,
      error_codes: [],
    });

    await h.db
      .update(adminsCfgSyncOutbox)
      .set({ appliedAt: new Date(), reloadOutcome: 'server_removed' })
      .where(
        and(
          eq(adminsCfgSyncOutbox.correlationId, eventId),
          eq(adminsCfgSyncOutbox.serverId, secondServerId),
        ),
      );
    const applied = await postStatus(eventId);
    expect(applied.json()).toEqual({
      ok: true,
      event_id: eventId,
      state: 'applied',
      action: 'assigned',
      servers_total: 2,
      servers_applied: 2,
      servers_pending: 0,
      error_codes: [],
    });
    expectSafeStatusBody(applied.json());
  });

  it.each([
    ['unavailable', 'applying'],
    ['timeout', 'applying'],
    ['rejected', 'failed'],
    ['invalid_result', 'failed'],
  ] as const)('maps a safe %s delivery code to %s', async (errorCode, state) => {
    const eventId = `vip-status-${errorCode}`;
    expect(
      (
        await postLifecycle({
          event_id: eventId,
          event_type: 'vip.purchased',
          player_id: playerId,
          role_id: roleId,
          tier: 'tier_1',
          purchase_id: `purchase-status-${errorCode}`,
          expires_at: '2030-01-02T03:04:05.000Z',
          revision: 1,
        })
      ).statusCode,
    ).toBe(202);
    await h.db
      .update(adminsCfgSyncOutbox)
      .set({
        relayedAt: new Date(),
        lastError: errorCode,
        reloadOutcome: errorCode,
      })
      .where(eq(adminsCfgSyncOutbox.correlationId, eventId));

    const response = await postStatus(eventId);

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      ok: true,
      event_id: eventId,
      state,
      action: 'assigned',
      servers_total: 1,
      servers_applied: 0,
      servers_pending: 1,
      error_codes: [errorCode],
    });
    expectSafeStatusBody(response.json());
  });

  it('does not expose an unexpected stored error as a status code', async () => {
    const eventId = 'vip-status-unsafe-error';
    expect(
      (
        await postLifecycle({
          event_id: eventId,
          event_type: 'vip.purchased',
          player_id: playerId,
          role_id: roleId,
          tier: 'tier_1',
          purchase_id: 'purchase-status-unsafe-error',
          expires_at: '2030-01-02T03:04:05.000Z',
          revision: 1,
        })
      ).statusCode,
    ).toBe(202);
    await h.db
      .update(adminsCfgSyncOutbox)
      .set({
        relayedAt: new Date(),
        lastError: 'raw RCON failure for 76561198000990001 at /srv/squad/Admins.cfg',
        reloadOutcome: null,
      })
      .where(eq(adminsCfgSyncOutbox.correlationId, eventId));

    const response = await postStatus(eventId);

    expect(response.json()).toEqual({
      ok: true,
      event_id: eventId,
      state: 'applying',
      action: 'assigned',
      servers_total: 1,
      servers_applied: 0,
      servers_pending: 1,
      error_codes: [],
    });
    expectSafeStatusBody(response.json());
  });

  it('never reports applied for an event without a non-empty outbox snapshot', async () => {
    const eventId = 'vip-status-empty-snapshot';
    await h.db.insert(vipLifecycleEvents).values({
      eventId,
      eventType: 'vip.purchased',
      playerId,
      roleId,
      revision: 1,
      action: 'assigned',
      payload: {},
      appliedAt: new Date(),
    });

    const response = await postStatus(eventId);

    expect(response.json()).toEqual({
      ok: true,
      event_id: eventId,
      state: 'accepted',
      action: 'assigned',
      servers_total: 0,
      servers_applied: 0,
      servers_pending: 0,
      error_codes: [],
    });
  });

  it('reports superseded before inspecting a late-completed outbox snapshot', async () => {
    expect((await postLifecycle(revisionEvent('vip-status-old', 4))).statusCode).toBe(202);
    expect((await postLifecycle(revisionEvent('vip-status-winner', 5))).statusCode).toBe(202);
    await h.db
      .update(adminsCfgSyncOutbox)
      .set({
        relayedAt: new Date(),
        appliedAt: new Date(),
        reloadOutcome: 'confirmed',
        lastError: 'raw RCON failure for 76561198000990001 at /srv/squad/Admins.cfg',
      })
      .where(eq(adminsCfgSyncOutbox.correlationId, 'vip-status-old'));

    const response = await postStatus('vip-status-old');

    expect(response.json()).toEqual({
      ok: true,
      event_id: 'vip-status-old',
      state: 'superseded',
      action: 'assigned',
      superseded_by_event_id: 'vip-status-winner',
      servers_total: 0,
      servers_applied: 0,
      servers_pending: 0,
      error_codes: [],
    });
    expectSafeStatusBody(response.json());
  });

  it('reads supersession and delivery aggregate from one PostgreSQL snapshot', async () => {
    const oldEventId = 'vip-status-snapshot-old';
    const winnerEventId = 'vip-status-snapshot-winner';
    expect((await postLifecycle(revisionEvent(oldEventId, 4))).statusCode).toBe(202);
    await h.db
      .update(adminsCfgSyncOutbox)
      .set({
        relayedAt: new Date(),
        appliedAt: new Date(),
        reloadOutcome: 'confirmed',
      })
      .where(eq(adminsCfgSyncOutbox.correlationId, oldEventId));
    await h.db.insert(vipLifecycleEvents).values({
      eventId: winnerEventId,
      eventType: 'vip.extended',
      playerId,
      roleId,
      revision: 5,
      action: 'assigned',
      payload: {},
      appliedAt: new Date(),
    });

    const blocker = postgres(h.app.config.DATABASE_URL, { max: 1, prepare: false });
    let signalLocked!: () => void;
    let releaseLock!: () => void;
    const locked = new Promise<void>((resolve) => {
      signalLocked = resolve;
    });
    const released = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });
    const blockerTransaction = blocker.begin(async (tx) => {
      await tx.unsafe('LOCK TABLE admins_cfg_sync_outbox IN ACCESS EXCLUSIVE MODE');
      signalLocked();
      await released;
    });
    await locked;

    const statusPromise = postStatus(oldEventId);
    try {
      await waitForBlockedStatusOutboxRead();
      await h.db
        .update(vipLifecycleEvents)
        .set({ supersededByEventId: winnerEventId })
        .where(eq(vipLifecycleEvents.eventId, oldEventId));
    } finally {
      releaseLock();
      await blockerTransaction;
      await blocker.end();
    }
    const response = await statusPromise;

    expect(response.json()).toEqual({
      ok: true,
      event_id: oldEventId,
      state: 'superseded',
      action: 'assigned',
      superseded_by_event_id: winnerEventId,
      servers_total: 0,
      servers_applied: 0,
      servers_pending: 0,
      error_codes: [],
    });
  });

  it('assigns a signed VIP purchase with expiry, publishes Admins.cfg sync, audits once and ignores duplicate delivery', async () => {
    const event = {
      event_id: 'vip-purchase-001',
      event_type: 'vip.purchased',
      player_id: playerId,
      role_id: roleId,
      tier: 'vip2',
      purchase_id: 'purchase-001',
      expires_at: '2030-01-02T03:04:05.000Z',
    };

    const first = await postLifecycle(event);

    expect(first.statusCode).toBe(202);
    expect(first.json()).toMatchObject({
      ok: true,
      duplicate: false,
      action: 'assigned',
      enqueued: 1,
    });
    const [assigned] = await h.db
      .select({
        roleId: players.roleId,
        roleExpiresAt: players.roleExpiresAt,
        roleComment: players.roleComment,
        roleLifecycleEventId: players.roleLifecycleEventId,
      })
      .from(players)
      .where(eq(players.id, playerId));
    expect(assigned?.roleId).toBe(roleId);
    expect(assigned?.roleExpiresAt?.toISOString()).toBe('2030-01-02T03:04:05.000Z');
    expect(assigned?.roleComment).toContain('purchase-001');
    expect(assigned?.roleLifecycleEventId).toBe(event.event_id);
    expect(await syncTasks()).toEqual([expect.objectContaining({ correlationId: event.event_id })]);
    expect(await latestVipAudit()).toMatchObject({
      actorKind: 'system',
      actorSystemLabel: 'vip-user-service',
      targetType: 'player',
      targetId: playerId,
    });

    const duplicate = await postLifecycle(event);

    expect(duplicate.statusCode).toBe(200);
    expect(duplicate.json()).toMatchObject({ ok: true, duplicate: true });
    expect(await syncTasks()).toHaveLength(1);
  });

  it('resolves an exact duplicate before manual ownership and target server checks', async () => {
    const event = {
      event_id: 'vip-duplicate-after-target-change',
      event_type: 'vip.purchased',
      player_id: playerId,
      role_id: roleId,
      tier: 'tier_1',
      purchase_id: 'purchase-duplicate-after-target-change',
      expires_at: '2030-01-02T03:04:05.000Z',
      revision: 1,
    };
    expect((await postLifecycle(event)).statusCode).toBe(202);
    expect(
      (
        await h.db
          .select({
            requestHash: vipLifecycleEvents.requestHash,
            revision: vipLifecycleEvents.revision,
          })
          .from(vipLifecycleEvents)
          .where(eq(vipLifecycleEvents.eventId, event.event_id))
      )[0],
    ).toEqual({
      requestHash: createHash('sha256').update(canonicalJson(event)).digest('hex'),
      revision: 1,
    });
    const counts = await mutationCounts(event.event_id);
    await h.db
      .update(players)
      .set({ roleLifecycleEventId: null, roleComment: 'manual override' })
      .where(eq(players.steamId64, 76561198000990001n));
    await h.db.update(servers).set({ deletedAt: new Date() }).where(eq(servers.id, serverId));

    const duplicate = await postLifecycle(event);

    expect(duplicate.statusCode).toBe(200);
    expect(duplicate.json()).toEqual({ ok: true, duplicate: true });
    expect(await mutationCounts(event.event_id)).toEqual(counts);
  });

  it('resolves an exact duplicate after its saved expiry has passed', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2029-01-01T00:00:00.000Z'));
    const event = {
      event_id: 'vip-duplicate-after-expiry',
      event_type: 'vip.purchased',
      player_id: playerId,
      role_id: roleId,
      tier: 'tier_1',
      purchase_id: 'purchase-duplicate-after-expiry',
      expires_at: '2030-01-01T00:00:00.000Z',
      revision: 1,
    };
    expect((await postLifecycle(event)).statusCode).toBe(202);
    const counts = await mutationCounts(event.event_id);
    vi.setSystemTime(new Date('2031-01-01T00:00:00.000Z'));

    const duplicate = await postLifecycle(event);

    expect(duplicate.statusCode).toBe(200);
    expect(duplicate.json()).toEqual({ ok: true, duplicate: true });
    expect(await mutationCounts(event.event_id)).toEqual(counts);

    const newExpiredEvent = await postLifecycle({
      ...event,
      event_id: 'vip-new-event-after-expiry',
      revision: 2,
    });
    expect(newExpiredEvent.statusCode).toBe(400);
    expect(newExpiredEvent.json()).toEqual({
      error: 'role_expiry_must_be_future',
      error_code: 'role_expiry_must_be_future',
    });
    expect(await mutationCounts(event.event_id)).toEqual(counts);
  });

  it.each([
    ['tier', { tier: 'changed-tier' }],
    ['expiry', { expires_at: '2030-02-02T03:04:05.000Z' }],
  ])('rejects the same event id with changed %s before target checks', async (_field, change) => {
    const event = {
      event_id: 'vip-event-body-conflict',
      event_type: 'vip.purchased',
      player_id: playerId,
      role_id: roleId,
      tier: 'tier_1',
      purchase_id: 'purchase-event-body-conflict',
      expires_at: '2030-01-02T03:04:05.000Z',
      revision: 1,
    };
    expect((await postLifecycle(event)).statusCode).toBe(202);
    const counts = await mutationCounts(event.event_id);
    await h.db
      .update(players)
      .set({ roleLifecycleEventId: null, roleComment: 'manual override' })
      .where(eq(players.steamId64, 76561198000990001n));
    await h.db.update(servers).set({ deletedAt: new Date() }).where(eq(servers.id, serverId));

    const conflict = await postLifecycle({ ...event, ...change });

    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toEqual({
      error: 'event_body_conflict',
      error_code: 'event_body_conflict',
    });
    expect(await mutationCounts(event.event_id)).toEqual(counts);
  });

  it('returns a safe body conflict when the same event id races across players', async () => {
    const [otherPlayer] = await h.db
      .insert(players)
      .values({
        steamId64: 76561198000990003n,
        canonicalName: 'VipLifecycleOtherPlayer',
        canonicalNameNormalized: 'viplifecycleotherplayer',
        eosId: `vip-lifecycle-other-eos-${Date.now()}`,
      })
      .returning({ id: players.id });
    const event = {
      event_id: 'vip-cross-player-event-race',
      event_type: 'vip.purchased',
      role_id: roleId,
      tier: 'tier_1',
      purchase_id: 'purchase-cross-player-race',
      expires_at: '2030-01-02T03:04:05.000Z',
      revision: 1,
    };

    const responses = await Promise.all([
      postLifecycle({ ...event, player_id: playerId }),
      postLifecycle({ ...event, player_id: otherPlayer?.id }),
    ]);

    expect(responses.map((response) => response.statusCode).sort()).toEqual([202, 409]);
    expect(responses.find((response) => response.statusCode === 409)?.json()).toEqual({
      error: 'event_body_conflict',
      error_code: 'event_body_conflict',
    });
  });

  it('rejects a different event that reuses the same player revision', async () => {
    const first = {
      event_id: 'vip-revision-owner',
      event_type: 'vip.purchased',
      player_id: playerId,
      role_id: roleId,
      tier: 'tier_1',
      purchase_id: 'purchase-revision-owner',
      expires_at: '2030-01-02T03:04:05.000Z',
      revision: 4,
    };
    expect((await postLifecycle(first)).statusCode).toBe(202);
    const counts = await mutationCounts(first.event_id);
    await h.db.update(players).set({ eosId: null }).where(eq(players.id, playerId));
    await h.db.update(servers).set({ deletedAt: new Date() }).where(eq(servers.id, serverId));

    const conflict = await postLifecycle({
      ...first,
      event_id: 'vip-revision-intruder',
      expires_at: '2030-02-02T03:04:05.000Z',
    });

    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toEqual({
      error: 'revision_conflict',
      error_code: 'revision_conflict',
    });
    expect(await mutationCounts(first.event_id)).toEqual(counts);
  });

  function revisionEvent(eventId: string, revision: number) {
    return {
      event_id: eventId,
      event_type: revision === 4 ? 'vip.purchased' : 'vip.extended',
      player_id: playerId,
      role_id: roleId,
      tier: 'tier_1',
      purchase_id: `purchase-revision-${revision}`,
      expires_at: `2030-0${revision}-02T03:04:05.000Z`,
      revision,
    };
  }

  it('lets revision 5 supersede an already accepted revision 4', async () => {
    const fourth = await postLifecycle(revisionEvent('vip-order-4', 4));
    const fifth = await postLifecycle(revisionEvent('vip-order-5', 5));

    expect(fourth.statusCode).toBe(202);
    expect(fifth.statusCode).toBe(202);
    expect(fifth.json()).toMatchObject({ action: 'assigned' });
    expect(
      (
        await h.db
          .select({ marker: players.roleLifecycleEventId, expiresAt: players.roleExpiresAt })
          .from(players)
          .where(eq(players.id, playerId))
      )[0],
    ).toEqual({ marker: 'vip-order-5', expiresAt: new Date('2030-05-02T03:04:05.000Z') });
    expect(
      (
        await h.db
          .select({
            action: vipLifecycleEvents.action,
            supersededBy: vipLifecycleEvents.supersededByEventId,
          })
          .from(vipLifecycleEvents)
          .where(eq(vipLifecycleEvents.eventId, 'vip-order-4'))
      )[0],
    ).toEqual({ action: 'assigned', supersededBy: 'vip-order-5' });
  });

  it('records a late revision 4 as superseded without mutating revision 5', async () => {
    const fifthFirst = await postLifecycle(revisionEvent('vip-reverse-5', 5));
    const countsAfterWinner = await mutationCounts('vip-reverse-5');
    await h.db.update(players).set({ eosId: null }).where(eq(players.id, playerId));
    await h.db.update(servers).set({ deletedAt: new Date() }).where(eq(servers.id, serverId));
    const fourthLate = await postLifecycle(revisionEvent('vip-reverse-4', 4));

    expect(fifthFirst.statusCode).toBe(202);
    expect(fourthLate.statusCode).toBe(202);
    expect(fourthLate.json()).toMatchObject({ action: 'superseded', enqueued: 0 });
    expect(
      (
        await h.db
          .select({ marker: players.roleLifecycleEventId, expiresAt: players.roleExpiresAt })
          .from(players)
          .where(eq(players.id, playerId))
      )[0],
    ).toEqual({ marker: 'vip-reverse-5', expiresAt: new Date('2030-05-02T03:04:05.000Z') });
    expect(await mutationCounts('vip-reverse-5')).toEqual({
      ...countsAfterWinner,
      events: countsAfterWinner.events,
    });
    expect(
      (
        await h.db
          .select({
            action: vipLifecycleEvents.action,
            supersededBy: vipLifecycleEvents.supersededByEventId,
          })
          .from(vipLifecycleEvents)
          .where(eq(vipLifecycleEvents.eventId, 'vip-reverse-4'))
      )[0],
    ).toEqual({ action: 'superseded', supersededBy: 'vip-reverse-5' });
  });

  it.each([
    ['missing expiry', {}, 'expires_at_required'],
    ['past expiry', { expires_at: '2020-01-01T00:00:00.000Z' }, 'role_expiry_must_be_future'],
  ])(
    'rejects a lower malformed activation with %s before revision handling',
    async (_case, extra, error) => {
      expect((await postLifecycle(revisionEvent('vip-malformed-winner-5', 5))).statusCode).toBe(
        202,
      );
      const countsBefore = await mutationCounts('vip-malformed-loser-4');

      const malformed = await postLifecycle({
        event_id: 'vip-malformed-loser-4',
        event_type: 'vip.purchased',
        player_id: playerId,
        role_id: roleId,
        tier: 'tier_1',
        purchase_id: 'purchase-malformed-4',
        revision: 4,
        ...extra,
      });

      expect(malformed.statusCode).toBe(400);
      expect(malformed.json()).toEqual({
        error,
        error_code: error,
      });
      expect(await mutationCounts('vip-malformed-loser-4')).toEqual(countsBefore);
    },
  );

  it('serializes concurrent revisions and leaves the larger revision as the only projection', async () => {
    const makeEvent = (revision: number) => ({
      event_id: `vip-concurrent-${revision}`,
      event_type: revision === 4 ? 'vip.purchased' : 'vip.extended',
      player_id: playerId,
      role_id: roleId,
      tier: 'tier_1',
      purchase_id: `purchase-concurrent-${revision}`,
      expires_at: `2030-0${revision}-02T03:04:05.000Z`,
      revision,
    });

    const responses = await Promise.all([postLifecycle(makeEvent(4)), postLifecycle(makeEvent(5))]);

    expect(responses.map((response) => response.statusCode)).toEqual([202, 202]);
    const [projection] = await h.db
      .select({ marker: players.roleLifecycleEventId, expiresAt: players.roleExpiresAt })
      .from(players)
      .where(eq(players.id, playerId));
    expect(projection).toEqual({
      marker: 'vip-concurrent-5',
      expiresAt: new Date('2030-05-02T03:04:05.000Z'),
    });
    const events = await h.db
      .select({
        eventId: vipLifecycleEvents.eventId,
        action: vipLifecycleEvents.action,
        supersededBy: vipLifecycleEvents.supersededByEventId,
      })
      .from(vipLifecycleEvents)
      .where(eq(vipLifecycleEvents.playerId, playerId));
    expect(events).toHaveLength(2);
    expect(events.find((event) => event.eventId === 'vip-concurrent-4')).toMatchObject({
      supersededBy: 'vip-concurrent-5',
    });
    expect(events.find((event) => event.eventId === 'vip-concurrent-5')).toEqual({
      eventId: 'vip-concurrent-5',
      action: 'assigned',
      supersededBy: null,
    });
    const counts = await mutationCounts('vip-concurrent-5');
    expect(counts.audits).toBeGreaterThanOrEqual(1);
    expect(counts.audits).toBeLessThanOrEqual(2);
    expect(counts.outbox).toBe(counts.audits);
  });

  it('rejects legacy delivery after revisioned history exists', async () => {
    const revisioned = {
      event_id: 'vip-revisioned-history',
      event_type: 'vip.purchased',
      player_id: playerId,
      role_id: roleId,
      tier: 'tier_1',
      purchase_id: 'purchase-revisioned-history',
      expires_at: '2030-01-02T03:04:05.000Z',
      revision: 1,
    };
    expect((await postLifecycle(revisioned)).statusCode).toBe(202);

    const { revision: _revision, ...legacyBody } = revisioned;
    const legacy = await postLifecycle({
      ...legacyBody,
      event_id: 'vip-legacy-after-revision',
      expires_at: '2030-02-02T03:04:05.000Z',
    });

    expect(legacy.statusCode).toBe(409);
    expect(legacy.json()).toEqual({
      error: 'revision_required',
      error_code: 'revision_required',
    });
  });

  it('uses future expires_at on vip.refunded as desired state and lets the same purchase revoke after expiry', async () => {
    const eventType = 'vip.refunded';
    const suffix = 'refunded';
    const compensation = {
      event_id: `vip-${suffix}-compensation`,
      event_type: eventType,
      player_id: playerId,
      role_id: roleId,
      tier: 'tier_1',
      purchase_id: `purchase-${suffix}-compensation`,
      expires_at: '2030-06-02T03:04:05.000Z',
      revision: 1,
    };

    const restored = await postLifecycle(compensation);

    expect(restored.statusCode).toBe(202);
    expect(restored.json()).toMatchObject({ action: 'assigned' });
    expect(
      (
        await h.db
          .select({ marker: players.roleLifecycleEventId, expiresAt: players.roleExpiresAt })
          .from(players)
          .where(eq(players.id, playerId))
      )[0],
    ).toEqual({
      marker: compensation.event_id,
      expiresAt: new Date(compensation.expires_at),
    });

    const revoked = await postLifecycle({
      ...compensation,
      event_id: `vip-${suffix}-expired`,
      expires_at: '2020-06-02T03:04:05.000Z',
      revision: 2,
    });

    expect(revoked.statusCode).toBe(202);
    expect(revoked.json()).toMatchObject({ action: 'revoked' });
    expect(
      (
        await h.db
          .select({ roleId: players.roleId, marker: players.roleLifecycleEventId })
          .from(players)
          .where(eq(players.id, playerId))
      )[0],
    ).toEqual({ roleId: null, marker: null });
  });

  it('never assigns on vip.expired even when panel time sees expires_at in the future', async () => {
    const purchase = {
      event_id: 'vip-expired-clock-skew-purchase',
      event_type: 'vip.purchased',
      player_id: playerId,
      role_id: roleId,
      tier: 'tier_1',
      purchase_id: 'purchase-expired-clock-skew',
      expires_at: '2030-06-02T03:04:05.000Z',
      revision: 1,
    };
    expect((await postLifecycle(purchase)).json()).toMatchObject({ action: 'assigned' });

    const expired = await postLifecycle({
      ...purchase,
      event_id: 'vip-expired-clock-skew-expiry',
      event_type: 'vip.expired',
      revision: 2,
    });

    expect(expired.statusCode).toBe(202);
    expect(expired.json()).toMatchObject({ action: 'revoked', enqueued: 1 });
    const [stored] = await h.db
      .select({ roleId: players.roleId })
      .from(players)
      .where(eq(players.id, playerId));
    expect(stored?.roleId).toBeNull();
  });

  it('enqueues correlated snapshot rows when natural expiry is already reflected in the player', async () => {
    const eventId = 'vip-expired-already-cleared';
    const response = await postLifecycle({
      event_id: eventId,
      event_type: 'vip.expired',
      player_id: playerId,
      role_id: roleId,
      tier: 'tier_1',
      purchase_id: 'purchase-already-cleared',
      expires_at: '2020-06-02T03:04:05.000Z',
      revision: 1,
    });

    expect(response.statusCode).toBe(202);
    expect(response.json()).toMatchObject({ action: 'ignored', enqueued: 1 });
    const tasks = await h.db
      .select({ serverId: adminsCfgSyncOutbox.serverId })
      .from(adminsCfgSyncOutbox)
      .where(eq(adminsCfgSyncOutbox.correlationId, eventId));
    expect(tasks).toEqual([{ serverId }]);
  });

  it('accepts signed preflight by stable external tier label without matching the editable tier name', async () => {
    const payload = {
      steam_id64: '76561198000990001',
      role_id: roleId,
      tier: 'tier_1',
    };

    const res = await postPreflight(payload);

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      ok: true,
      servers_total: 1,
      projection_owner: null,
      expires_at: null,
    });
  });

  it('requires a valid signature for preflight', async () => {
    const res = await postPreflight(
      { steam_id64: '76561198000990001', role_id: roleId, tier: 'tier_1' },
      'sha256=bad',
    );

    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: 'invalid_signature' });
  });

  it.each([
    ['missing EOS', 'player_eos_missing', 409],
    ['inactive VIP tier', 'role_not_vip', 403],
    ['role outside the VIP catalog', 'role_not_vip', 403],
    ['ambiguous active VIP tier', 'role_not_vip', 403],
    ['system role', 'role_not_vip', 403],
    ['role with panel access', 'role_not_vip', 403],
    ['different current role', 'role_conflict', 409],
    ['manually assigned matching VIP role', 'manual_role_conflict', 409],
    ['active internal VIP subscription', 'vip_subscription_conflict', 409],
  ])(
    'rejects %s in preflight and lifecycle without audit, outbox or player mutation',
    async (scenario, error, status) => {
      const expiresAt = new Date('2030-01-01T00:00:00.000Z');
      if (scenario === 'missing EOS') {
        await h.db.update(players).set({ eosId: null }).where(eq(players.id, playerId));
      } else if (scenario === 'inactive VIP tier') {
        await h.db.update(vipTiers).set({ isActive: false }).where(eq(vipTiers.id, tierId));
      } else if (scenario === 'role outside the VIP catalog') {
        await h.db.delete(vipTiers).where(eq(vipTiers.id, tierId));
      } else if (scenario === 'ambiguous active VIP tier') {
        await h.db.insert(vipTiers).values({
          id: uuidv7(),
          name: `VIP Bronze duplicate ${Date.now()}`,
          roleId,
          isActive: true,
        });
      } else if (scenario === 'system role') {
        await h.db.update(roles).set({ isSystemRole: true }).where(eq(roles.id, roleId));
      } else if (scenario === 'role with panel access') {
        await h.db.update(roles).set({ panelAccess: true }).where(eq(roles.id, roleId));
      } else if (scenario === 'different current role') {
        const otherRoleId = uuidv7();
        await h.db.insert(roles).values({ id: otherRoleId, name: `Other ${Date.now()}` });
        await h.db
          .update(players)
          .set({ roleId: otherRoleId, roleExpiresAt: expiresAt, roleComment: 'manual' })
          .where(eq(players.steamId64, 76561198000990001n));
      } else if (scenario === 'manually assigned matching VIP role') {
        await h.db
          .update(players)
          .set({ roleId, roleExpiresAt: expiresAt, roleComment: 'manual' })
          .where(eq(players.steamId64, 76561198000990001n));
      } else if (scenario === 'active internal VIP subscription') {
        await h.db.insert(vipSubscriptions).values({
          id: uuidv7(),
          playerId,
          tierId,
          status: 'active',
          renewsEveryDays: 30,
          priceBonuses: 100,
          nextRenewalAt: expiresAt,
        });
      }
      const [before] = await h.db
        .select({
          roleId: players.roleId,
          roleExpiresAt: players.roleExpiresAt,
          roleComment: players.roleComment,
        })
        .from(players)
        .where(eq(players.id, playerId));
      const eventId = `vip-rejected-${scenario.replaceAll(' ', '-')}`;
      const countsBefore = await mutationCounts(eventId);

      const preflight = await postPreflight({
        steam_id64: '76561198000990001',
        role_id: roleId,
        tier: 'tier_1',
      });
      expect(preflight.statusCode).toBe(status);
      expect(preflight.json()).toEqual({ error, error_code: error });
      expect(await mutationCounts(eventId)).toEqual(countsBefore);

      const res = await postLifecycle({
        event_id: eventId,
        event_type: 'vip.purchased',
        player_id: playerId,
        role_id: roleId,
        tier: 'tier_1',
        purchase_id: `purchase-${scenario}`,
        expires_at: '2031-01-02T03:04:05.000Z',
      });

      expect(res.statusCode).toBe(status);
      expect(res.json()).toEqual({ error, error_code: error });
      const [after] = await h.db
        .select({
          roleId: players.roleId,
          roleExpiresAt: players.roleExpiresAt,
          roleComment: players.roleComment,
        })
        .from(players)
        .where(eq(players.id, playerId));
      expect(after).toEqual(before);
      expect(await mutationCounts(eventId)).toEqual(countsBefore);
    },
  );

  it('allows a new external purchase to extend, but a stale refund cannot revoke it', async () => {
    const purchase = {
      event_id: 'vip-owner-purchase',
      event_type: 'vip.purchased',
      player_id: playerId,
      role_id: roleId,
      tier: 'tier_1',
      purchase_id: 'external-purchase-1',
      expires_at: '2030-01-02T03:04:05.000Z',
      revision: 4,
    };
    expect((await postLifecycle(purchase)).statusCode).toBe(202);

    const preflight = await postPreflight({
      steam_id64: '76561198000990001',
      role_id: roleId,
      tier: 'tier_1',
    });
    expect(preflight.statusCode).toBe(200);
    expect(preflight.json()).toEqual({
      ok: true,
      servers_total: 1,
      projection_owner: 'bss-store',
      expires_at: '2030-01-02T03:04:05.000Z',
    });

    const extension = await postLifecycle({
      ...purchase,
      event_id: 'vip-owner-extension',
      event_type: 'vip.extended',
      purchase_id: 'external-purchase-2',
      expires_at: '2030-02-02T03:04:05.000Z',
      revision: 5,
    });
    expect(extension.statusCode).toBe(202);
    expect(extension.json()).toMatchObject({ action: 'assigned' });

    const staleRefund = await postLifecycle({
      ...purchase,
      event_id: 'vip-owner-stale-refund',
      event_type: 'vip.refunded',
      expires_at: '2020-01-02T03:04:05.000Z',
      revision: 6,
    });
    expect(staleRefund.statusCode).toBe(409);
    expect(staleRefund.json()).toEqual({
      error: 'manual_role_conflict',
      error_code: 'manual_role_conflict',
    });
    const [afterStaleRefund] = await h.db
      .select({ roleId: players.roleId, roleExpiresAt: players.roleExpiresAt })
      .from(players)
      .where(eq(players.id, playerId));
    expect(afterStaleRefund?.roleId).toBe(roleId);
    expect(afterStaleRefund?.roleExpiresAt?.toISOString()).toBe('2030-02-02T03:04:05.000Z');

    await h.db
      .update(players)
      .set({ roleLifecycleEventId: null })
      .where(eq(players.steamId64, 76561198000990001n));
    const afterManualOverride = await postLifecycle({
      ...purchase,
      event_id: 'vip-owner-extension-after-manual-change',
      event_type: 'vip.extended',
      purchase_id: 'external-purchase-3',
      expires_at: '2030-03-02T03:04:05.000Z',
      revision: 7,
    });
    expect(afterManualOverride.statusCode).toBe(409);
    expect(afterManualOverride.json()).toEqual({
      error: 'manual_role_conflict',
      error_code: 'manual_role_conflict',
    });
    expect(
      (
        await h.db
          .select({ roleComment: players.roleComment, marker: players.roleLifecycleEventId })
          .from(players)
          .where(eq(players.id, playerId))
      )[0],
    ).toMatchObject({ marker: null });
  });

  it('rechecks a non-empty server snapshot after preflight and rolls back when it disappeared', async () => {
    const preflightBody = {
      steam_id64: '76561198000990001',
      role_id: roleId,
      tier: 'tier_1',
    };
    expect((await postPreflight(preflightBody)).json()).toMatchObject({ servers_total: 1 });
    await h.db.update(servers).set({ deletedAt: new Date() }).where(eq(servers.id, serverId));
    const eventId = 'vip-no-target-servers';
    const countsBefore = await mutationCounts(eventId);

    const res = await postLifecycle({
      event_id: eventId,
      event_type: 'vip.purchased',
      player_id: playerId,
      role_id: roleId,
      tier: 'tier_1',
      purchase_id: 'purchase-no-target',
      expires_at: '2030-01-02T03:04:05.000Z',
    });

    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({
      error: 'no_target_servers',
      error_code: 'no_target_servers',
    });
    expect(await mutationCounts(eventId)).toEqual(countsBefore);
    expect(
      (
        await h.db.select({ roleId: players.roleId }).from(players).where(eq(players.id, playerId))
      )[0]?.roleId,
    ).toBeNull();
  });

  it('assigns a signed VIP purchase by steam_id64 when producer does not know panel player_id', async () => {
    const event = {
      event_id: 'vip-purchase-by-steam-001',
      event_type: 'vip.purchased',
      steam_id64: '76561198000990001',
      role_id: roleId,
      tier: 'vip2',
      purchase_id: 'purchase-by-steam-001',
      expires_at: '2030-01-02T03:04:05.000Z',
    };

    const res = await postLifecycle(event);

    expect(res.statusCode).toBe(202);
    expect(res.json()).toMatchObject({
      ok: true,
      duplicate: false,
      action: 'assigned',
      enqueued: 1,
    });
    const [assigned] = await h.db
      .select({
        roleId: players.roleId,
        roleExpiresAt: players.roleExpiresAt,
        roleComment: players.roleComment,
        roleLifecycleEventId: players.roleLifecycleEventId,
      })
      .from(players)
      .where(eq(players.id, playerId));
    expect(assigned?.roleId).toBe(roleId);
    expect(assigned?.roleExpiresAt?.toISOString()).toBe('2030-01-02T03:04:05.000Z');
    expect(assigned?.roleComment).toContain('purchase-by-steam-001');
    expect(await latestVipAudit()).toMatchObject({
      targetId: playerId,
    });
  });

  it('accepts optional revision and signed discord_id without using Discord identity', async () => {
    const event = {
      event_id: 'vip-purchase-compatible-contract-001',
      event_type: 'vip.purchased',
      steam_id64: '76561198000990001',
      role_id: roleId,
      tier: 'vip2',
      purchase_id: 'purchase-compatible-contract-001',
      expires_at: '2030-01-02T03:04:05.000Z',
      revision: 1,
      discord_id: '123456789012345678',
    };

    const res = await postLifecycle(event);

    expect(res.statusCode).toBe(202);
    const [stored] = await h.db
      .select({ payload: vipLifecycleEvents.payload })
      .from(vipLifecycleEvents)
      .where(eq(vipLifecycleEvents.eventId, event.event_id));
    expect(stored?.payload).toMatchObject({
      revision: 1,
      discord_id: '123456789012345678',
    });
  });

  it('requires revision before a transaction when the compatibility flag is enabled', async () => {
    (h.app.config as Record<string, unknown>).VIP_LIFECYCLE_REQUIRE_REVISION = true;
    const event = {
      event_id: 'vip-purchase-revision-required-001',
      event_type: 'vip.purchased',
      player_id: playerId,
      role_id: roleId,
      tier: 'vip2',
      purchase_id: 'purchase-revision-required-001',
      expires_at: '2030-01-02T03:04:05.000Z',
    };

    const res = await postLifecycle(event);

    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'revision_required' });
    const [player] = await h.db
      .select({ roleId: players.roleId })
      .from(players)
      .where(eq(players.id, playerId));
    expect(player?.roleId).toBeNull();
    const stored = await h.db
      .select({ eventId: vipLifecycleEvents.eventId })
      .from(vipLifecycleEvents)
      .where(eq(vipLifecycleEvents.eventId, event.event_id));
    expect(stored).toHaveLength(0);
  });

  it.each([
    ['revision', 0],
    ['revision', 1.5],
    ['discord_id', '1234567890123456'],
    ['discord_id', '123456789012345678901'],
    ['discord_id', '12345678901234567x'],
  ])('rejects an invalid %s value', async (field, value) => {
    const event = {
      event_id: `vip-purchase-invalid-${field}-${String(value)}`,
      event_type: 'vip.purchased',
      player_id: playerId,
      role_id: roleId,
      tier: 'vip2',
      purchase_id: `purchase-invalid-${field}-${String(value)}`,
      expires_at: '2030-01-02T03:04:05.000Z',
      [field]: value,
    };

    const res = await postLifecycle(event);

    expect(res.statusCode).toBe(400);
  });

  it('revokes only the matching VIP role on refund and is idempotent on retry', async () => {
    const expiresAt = new Date('2030-05-06T07:08:09.000Z');
    const purchase = {
      event_id: 'vip-purchase-before-refund-002',
      event_type: 'vip.purchased',
      player_id: playerId,
      role_id: roleId,
      tier: 'vip2',
      purchase_id: 'purchase-002',
      expires_at: expiresAt.toISOString(),
    };
    expect((await postLifecycle(purchase)).statusCode).toBe(202);
    const event = {
      event_id: 'vip-refund-002',
      event_type: 'vip.refunded',
      player_id: playerId,
      role_id: roleId,
      tier: 'vip2',
      purchase_id: 'purchase-002',
    };

    const first = await postLifecycle(event);

    expect(first.statusCode).toBe(202);
    expect(first.json()).toMatchObject({
      ok: true,
      duplicate: false,
      action: 'revoked',
      enqueued: 1,
    });
    const [revoked] = await h.db
      .select({
        roleId: players.roleId,
        roleExpiresAt: players.roleExpiresAt,
        roleComment: players.roleComment,
        roleLifecycleEventId: players.roleLifecycleEventId,
      })
      .from(players)
      .where(eq(players.id, playerId));
    expect(revoked?.roleId).toBeNull();
    expect(revoked?.roleExpiresAt).toBeNull();
    expect(revoked?.roleComment).toBeNull();
    expect(revoked?.roleLifecycleEventId).toBeNull();

    const duplicate = await postLifecycle(event);

    expect(duplicate.statusCode).toBe(200);
    expect(duplicate.json()).toMatchObject({ ok: true, duplicate: true });
    expect(await syncTasks()).toHaveLength(2);
  });

  it('rejects an invalid signature before changing role state', async () => {
    const event = {
      event_id: 'vip-purchase-invalid-signature',
      event_type: 'vip.purchased',
      player_id: playerId,
      role_id: roleId,
      tier: 'vip1',
      purchase_id: 'purchase-invalid',
      expires_at: '2030-01-02T03:04:05.000Z',
    };

    const res = await postLifecycle(event, 'sha256=bad');

    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: 'invalid_signature' });
    const [player] = await h.db
      .select({ roleId: players.roleId })
      .from(players)
      .where(eq(players.id, playerId));
    expect(player?.roleId).toBeNull();
    expect(await syncTasks()).toHaveLength(0);
  });
});
