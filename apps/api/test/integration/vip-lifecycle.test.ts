import { createHmac } from 'node:crypto';
import { auditLog, players, roles, servers } from '@squad/db/schema';
import { desc, eq } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildIntegrationApp, type IntegrationHarness, makeFakeBridge } from './harness.js';

const SECRET = 'vip-lifecycle-test-secret-with-enough-entropy';
const SIGNED_AT = '2026-07-06T05:00:00.000Z';

let h: IntegrationHarness;
let playerId: string;
let roleId: string;
let serverId: string;

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

function sign(payload: unknown, timestamp = SIGNED_AT): string {
  return `sha256=${createHmac('sha256', SECRET)
    .update(`${timestamp}.${canonicalJson(payload)}`)
    .digest('hex')}`;
}

async function postLifecycle(payload: Record<string, unknown>, signature = sign(payload)) {
  return h.app.inject({
    method: 'POST',
    url: '/api/v1/integrations/vip/lifecycle',
    headers: {
      'content-type': 'application/json',
      'x-vip-timestamp': SIGNED_AT,
      'x-vip-signature': signature,
    },
    payload: JSON.stringify(payload),
  });
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

    roleId = uuidv7();
    serverId = uuidv7();
    const playerRows = await h.db
      .insert(players)
      .values({
        steamId64: 76561198000990001n,
        canonicalName: 'VipLifecyclePlayer',
        canonicalNameNormalized: 'viplifecycleplayer',
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
      })
      .from(players)
      .where(eq(players.id, playerId));
    expect(assigned?.roleId).toBe(roleId);
    expect(assigned?.roleExpiresAt?.toISOString()).toBe('2030-01-02T03:04:05.000Z');
    expect(assigned?.roleComment).toContain('purchase-001');
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

  it('revokes only the matching VIP role on refund and is idempotent on retry', async () => {
    const expiresAt = new Date('2030-05-06T07:08:09.000Z');
    await h.db
      .update(players)
      .set({
        roleId,
        roleExpiresAt: expiresAt,
        roleComment: 'VIP vip2 purchase purchase-002',
      })
      .where(eq(players.id, playerId));
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
      })
      .from(players)
      .where(eq(players.id, playerId));
    expect(revoked?.roleId).toBeNull();
    expect(revoked?.roleExpiresAt).toBeNull();
    expect(revoked?.roleComment).toBeNull();

    const duplicate = await postLifecycle(event);

    expect(duplicate.statusCode).toBe(200);
    expect(duplicate.json()).toMatchObject({ ok: true, duplicate: true });
    expect(await syncEvents()).toHaveLength(1);
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
