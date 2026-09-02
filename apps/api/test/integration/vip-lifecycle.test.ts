import { createHmac } from 'node:crypto';
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
import { desc, eq } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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

async function syncEvents(): Promise<unknown[]> {
  const rows = await h.redis.xrange(`events:admins-cfg-sync:${serverId}`, '-', '+');
  return rows.map(([, fields]) => {
    const eventIndex = fields.indexOf('event');
    return JSON.parse(String(fields[eventIndex + 1]));
  });
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
    await h.cleanup();
  }, 60_000);

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
    expect(await syncEvents()).toHaveLength(1);
    expect(await latestVipAudit()).toMatchObject({
      actorKind: 'system',
      actorSystemLabel: 'vip-user-service',
      targetType: 'player',
      targetId: playerId,
    });

    const duplicate = await postLifecycle(event);

    expect(duplicate.statusCode).toBe(200);
    expect(duplicate.json()).toMatchObject({ ok: true, duplicate: true });
    expect(await syncEvents()).toHaveLength(1);
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
    });
    expect(extension.statusCode).toBe(202);
    expect(extension.json()).toMatchObject({ action: 'assigned' });

    const staleRefund = await postLifecycle({
      ...purchase,
      event_id: 'vip-owner-stale-refund',
      event_type: 'vip.refunded',
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
    expect(await syncEvents()).toHaveLength(2);
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
    expect(await syncEvents()).toHaveLength(0);
  });
});
